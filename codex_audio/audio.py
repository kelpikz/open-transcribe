"""Audio sources: live microphone, or an existing file via ffmpeg."""

from __future__ import annotations

import asyncio
import fractions

import av
import numpy as np
import sounddevice as sd
from aiortc import MediaStreamTrack
from aiortc.contrib.media import MediaPlayer

SAMPLE_RATE = 48000
CHANNELS = 1
FRAME_MS = 20
SAMPLES_PER_FRAME = SAMPLE_RATE * FRAME_MS // 1000  # 960


class MicrophoneTrack(MediaStreamTrack):
    """Live mic capture as a WebRTC audio track.

    sounddevice hands us buffers on its own PortAudio thread, so frames cross
    into the event loop through a bounded queue. Bounded on purpose: if the
    encoder ever falls behind we drop the oldest audio rather than grow without
    limit, since stale audio is worthless for live dictation anyway.
    """

    kind = "audio"

    def __init__(self, device: int | str | None = None) -> None:
        super().__init__()
        self._loop = asyncio.get_running_loop()
        self._queue: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=50)
        self._pts = 0
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
            blocksize=SAMPLES_PER_FRAME,
            device=device,
            callback=self._on_audio,
        )
        self._stream.start()

    def _on_audio(self, indata, frames, time_info, status) -> None:  # PortAudio thread
        chunk = indata.copy().reshape(1, -1)  # av wants (channels, samples)
        self._loop.call_soon_threadsafe(self._enqueue, chunk)

    def _enqueue(self, chunk: np.ndarray) -> None:
        if self._queue.full():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self._queue.put_nowait(chunk)

    async def recv(self) -> av.AudioFrame:
        chunk = await self._queue.get()
        frame = av.AudioFrame.from_ndarray(chunk, format="s16", layout="mono")
        frame.sample_rate = SAMPLE_RATE
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, SAMPLE_RATE)
        self._pts += chunk.shape[1]
        return frame

    def stop(self) -> None:
        try:
            self._stream.stop()
            self._stream.close()
        except Exception:
            pass
        super().stop()


def file_track(path: str) -> MediaStreamTrack:
    """Audio track read from any file ffmpeg can decode."""
    player = MediaPlayer(path)
    if player.audio is None:
        raise RuntimeError(f"no audio stream found in {path}")
    # Keep the player alive as long as the track is.
    player.audio._player_ref = player  # type: ignore[attr-defined]
    return player.audio


def list_devices() -> str:
    return str(sd.query_devices())
