"""Tests for codex_audio/audio.py.

Run with: .venv/Scripts/python.exe -m pytest tests_py/test_audio.py -q

No fixtures exist for this module (it is I/O-bound: microphone capture,
ffmpeg-backed file playback). These tests pin down what is genuinely
verifiable without a real microphone or audio device:

- the module constants (both the 48000/960 legacy set and the 24000/2400
  recording set used by record_microphone),
- the exact bytes record_microphone() writes for a WAV file, built
  independently from first principles (not by calling `wave` a second time)
  so the assertion is a real cross-check,
- the "no audio was captured" error path,
- the exact InputStream parameters record_microphone() passes to
  sounddevice,
- MicrophoneTrack's drop-oldest-when-full queue behaviour,
- MicrophoneTrack.recv() frame construction,
- file_track()'s "no audio stream found" error and its _player_ref
  GC-keepalive trick, both via a stubbed MediaPlayer (no real ffmpeg
  decode needed to exercise this branch of the Python).

Nothing here touches a real microphone or blocks on real stdin: sd.InputStream
is always monkeypatched to an in-process fake, and stdin reads are driven
synchronously through asyncio.to_thread from a controlled fake.
"""

from __future__ import annotations

import asyncio
import struct
import sys

import numpy as np
import pytest

from codex_audio import audio as audio_mod


# --------------------------------------------------------------- constants


def test_legacy_webrtc_constants():
    assert audio_mod.SAMPLE_RATE == 48000
    assert audio_mod.CHANNELS == 1
    assert audio_mod.FRAME_MS == 20
    assert audio_mod.SAMPLES_PER_FRAME == 960


# ------------------------------------------------------------- fake stream


class FakeInputStream:
    """Stand-in for sd.InputStream that records its constructor args and
    lets the test drive the callback directly instead of touching
    PortAudio."""

    instances: list["FakeInputStream"] = []

    def __init__(self, *, samplerate, channels, dtype, blocksize, device, callback):
        self.samplerate = samplerate
        self.channels = channels
        self.dtype = dtype
        self.blocksize = blocksize
        self.device = device
        self.callback = callback
        self.started = False
        self.stopped = False
        self.closed = False
        FakeInputStream.instances.append(self)

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _reset_fake_instances():
    FakeInputStream.instances.clear()
    yield
    FakeInputStream.instances.clear()


# ------------------------------------------------------- WAV byte oracle


def build_expected_wav(pcm: bytes, *, sample_rate=24_000, channels=1, bits=16) -> bytes:
    """Build a canonical 44-byte-header PCM WAV independently of the `wave`
    stdlib module, so comparing against it is a real cross-check rather
    than the module checking its own homework."""
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    data_size = len(pcm)
    riff_size = 36 + data_size
    header = b"RIFF" + struct.pack("<I", riff_size) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, bits)
    header += b"data" + struct.pack("<I", data_size)
    return header + pcm


class FakeStdin:
    """Simulates stdin.readline(): first delivers synthetic audio chunks
    through the stream's callback, then returns a line, mimicking the user
    pressing Enter to stop recording."""

    def __init__(self, chunks: list[np.ndarray], stream_holder: list):
        self._chunks = chunks
        self._stream_holder = stream_holder

    def readline(self) -> str:
        stream = self._stream_holder[0]
        for chunk in self._chunks:
            stream.callback(chunk, chunk.shape[0], None, None)
        return "\n"


class EmptyStdin:
    def readline(self) -> str:
        return "\n"


def _run_record_microphone(monkeypatch, chunks: list[np.ndarray]):
    monkeypatch.setattr(audio_mod.sd, "InputStream", FakeInputStream)
    stream_holder: list = [None]

    real_init = FakeInputStream.__init__

    def capturing_init(self, **kwargs):
        real_init(self, **kwargs)
        stream_holder[0] = self

    monkeypatch.setattr(FakeInputStream, "__init__", capturing_init)
    monkeypatch.setattr(sys, "stdin", FakeStdin(chunks, stream_holder))
    return asyncio.run(audio_mod.record_microphone())


def test_record_microphone_produces_byte_exact_wav(monkeypatch):
    chunk_a = np.array([[1], [2], [3]], dtype="int16")
    chunk_b = np.array([[-1], [1000]], dtype="int16")
    wav_bytes = _run_record_microphone(monkeypatch, [chunk_a, chunk_b])

    pcm = np.concatenate([chunk_a, chunk_b], axis=0).astype("<i2", copy=False).tobytes()
    expected = build_expected_wav(pcm)
    assert wav_bytes == expected

    # Header sanity, spelled out explicitly for anyone reading this later.
    assert wav_bytes[0:4] == b"RIFF"
    assert wav_bytes[8:12] == b"WAVE"
    assert wav_bytes[12:16] == b"fmt "
    fmt_chunk = struct.unpack("<IHHIIHH", wav_bytes[16:36])
    assert fmt_chunk == (16, 1, 1, 24_000, 48_000, 2, 16)
    assert wav_bytes[36:40] == b"data"
    (data_size,) = struct.unpack("<I", wav_bytes[40:44])
    assert data_size == len(pcm)
    assert len(wav_bytes) == 44 + len(pcm)


def test_record_microphone_raises_when_nothing_captured(monkeypatch):
    monkeypatch.setattr(audio_mod.sd, "InputStream", FakeInputStream)
    monkeypatch.setattr(sys, "stdin", EmptyStdin())
    with pytest.raises(RuntimeError, match="no audio was captured"):
        asyncio.run(audio_mod.record_microphone())


def test_record_microphone_stream_params(monkeypatch):
    chunk = np.array([[42]], dtype="int16")
    _run_record_microphone(monkeypatch, [chunk])
    assert len(FakeInputStream.instances) == 1
    inst = FakeInputStream.instances[0]
    assert inst.samplerate == 24_000
    assert inst.channels == 1
    assert inst.dtype == "int16"
    assert inst.blocksize == 2_400
    assert inst.device is None
    assert inst.started is True
    assert inst.stopped is True
    assert inst.closed is True


def test_record_microphone_passes_device_through(monkeypatch):
    monkeypatch.setattr(audio_mod.sd, "InputStream", FakeInputStream)
    monkeypatch.setattr(sys, "stdin", FakeStdin([np.array([[1]], dtype="int16")], [None]))
    # patch stream_holder wiring manually since we bypass _run_record_microphone
    stream_holder: list = [None]
    real_init = FakeInputStream.__init__

    def capturing_init(self, **kwargs):
        real_init(self, **kwargs)
        stream_holder[0] = self

    monkeypatch.setattr(FakeInputStream, "__init__", capturing_init)
    monkeypatch.setattr(sys, "stdin", FakeStdin([np.array([[1]], dtype="int16")], stream_holder))
    asyncio.run(audio_mod.record_microphone(device=7))
    assert FakeInputStream.instances[-1].device == 7


def test_record_microphone_stops_stream_even_if_stdin_read_raises(monkeypatch):
    monkeypatch.setattr(audio_mod.sd, "InputStream", FakeInputStream)

    class RaisingStdin:
        def readline(self):
            raise OSError("stdin closed")

    monkeypatch.setattr(sys, "stdin", RaisingStdin())
    with pytest.raises(OSError):
        asyncio.run(audio_mod.record_microphone())
    assert FakeInputStream.instances[-1].stopped is True
    assert FakeInputStream.instances[-1].closed is True


# -------------------------------------------------------------- list_devices


def test_list_devices_returns_string():
    # Exact formatting is PortAudio/host-API/hardware dependent -- just pin
    # down that it is sd.query_devices() rendered as a string.
    result = audio_mod.list_devices()
    assert isinstance(result, str)


def test_list_devices_matches_query_devices_str(monkeypatch):
    class FakeDeviceList:
        def __repr__(self):
            return "fake device list"

    monkeypatch.setattr(audio_mod.sd, "query_devices", lambda: FakeDeviceList())
    assert audio_mod.list_devices() == "fake device list"


# ------------------------------------------------------------ MicrophoneTrack


async def _make_track(monkeypatch, device=None):
    monkeypatch.setattr(audio_mod.sd, "InputStream", FakeInputStream)
    track = audio_mod.MicrophoneTrack(device=device)
    return track


def test_microphone_track_queue_drops_oldest_when_full(monkeypatch):
    async def scenario():
        track = await _make_track(monkeypatch)
        for i in range(60):
            chunk = np.array([[i]], dtype="int16")
            track._enqueue(chunk)
        assert track._queue.qsize() == 50
        # oldest 10 (0..9) were dropped; first remaining item is index 10
        first = track._queue.get_nowait()
        assert first[0, 0] == 10
        track.stop()

    asyncio.run(scenario())


def test_microphone_track_stream_params(monkeypatch):
    async def scenario():
        track = await _make_track(monkeypatch, device="my-device")
        inst = FakeInputStream.instances[-1]
        assert inst.samplerate == 48_000
        assert inst.channels == 1
        assert inst.dtype == "int16"
        assert inst.blocksize == 960
        assert inst.device == "my-device"
        assert inst.started is True
        track.stop()

    asyncio.run(scenario())


def test_microphone_track_recv_builds_frame_and_increments_pts(monkeypatch):
    async def scenario():
        track = await _make_track(monkeypatch)
        # _on_audio reshapes PortAudio's (frames, channels) buffer to
        # (channels, samples) before enqueueing -- mimic that here since we
        # are calling _enqueue directly rather than through the callback.
        chunk1 = np.array([[1], [2], [3]], dtype="int16").reshape(1, -1)
        chunk2 = np.array([[4], [5]], dtype="int16").reshape(1, -1)
        track._enqueue(chunk1)
        track._enqueue(chunk2)

        frame1 = await track.recv()
        assert frame1.format.name == "s16"
        assert frame1.layout.name == "mono"
        assert frame1.sample_rate == 48_000
        assert frame1.pts == 0
        assert frame1.samples == 3

        frame2 = await track.recv()
        assert frame2.pts == 3
        assert frame2.samples == 2

        track.stop()

    asyncio.run(scenario())


def test_microphone_track_stop_is_safe_to_call_and_swallows_errors(monkeypatch):
    async def scenario():
        track = await _make_track(monkeypatch)
        inst = FakeInputStream.instances[-1]

        def boom():
            raise RuntimeError("already stopped")

        inst.stop = boom
        # Should not raise even though stream.stop() blows up.
        track.stop()
        assert track.readyState == "ended"

    asyncio.run(scenario())


# ----------------------------------------------------------------- file_track


class FakeAudioTrack:
    """Minimal stand-in for the aiortc MediaStreamTrack that MediaPlayer.audio
    would hand back."""

    def __init__(self):
        self.kind = "audio"


class FakePlayerWithAudio:
    def __init__(self, path):
        self.path = path
        self.audio = FakeAudioTrack()


class FakePlayerNoAudio:
    def __init__(self, path):
        self.path = path
        self.audio = None


def test_file_track_raises_when_no_audio_stream(monkeypatch):
    monkeypatch.setattr(audio_mod, "MediaPlayer", FakePlayerNoAudio)
    with pytest.raises(RuntimeError, match="no audio stream found in nope.mp4"):
        audio_mod.file_track("nope.mp4")


def test_file_track_returns_audio_and_keeps_player_alive(monkeypatch):
    monkeypatch.setattr(audio_mod, "MediaPlayer", FakePlayerWithAudio)
    track = audio_mod.file_track("some/file.wav")
    assert isinstance(track, FakeAudioTrack)
    # Python stashes the player on the track to defeat GC -- the audio.py
    # object must still be reachable through the returned track.
    assert track._player_ref.path == "some/file.wav"
    assert track._player_ref.audio is track
