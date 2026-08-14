"""Realtime transcription over WebRTC, against the endpoint Codex's mic uses.

Negotiation, as recovered from codex-cli 0.146.0 and confirmed live:

    POST {chatgpt_base_url}/codex/realtime/calls
    Content-Type: application/json
    Authorization: Bearer <chatgpt access token>
    ChatGPT-Account-Id: <account id>

    {"sdp": "<offer>", "session": {"type": "transcription", ...}}

    -> 201, body is the raw SDP answer

Transcripts then arrive as JSON events on the `oai-events` data channel.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Callable

import httpx
from aiortc import RTCPeerConnection, RTCSessionDescription

from .auth import ChatGPTAuth, chatgpt_base_url

# Field names and values lifted from the binary's serde metadata.
# Codex itself uses gpt-4o-mini-transcribe; the full model is the stronger one
# and costs us nothing extra here, so it is the default.
DEFAULT_MODEL = "gpt-4o-transcribe"
CODEX_MODEL = "gpt-4o-mini-transcribe"

# Verified accepted on this lane: gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-1.
TRANSCRIBE_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]


DEFAULT_LANGUAGE = "en"

# Codex's own transcription mode sends turn_detection: None and commits the
# buffer once, so the model transcribes the whole utterance with full context.
# server_vad (silence_duration_ms 500) is its *conversational* path, not this
# one. Segmenting is opt-in here for the same reason: each segment is
# transcribed in isolation, so cutting the audio costs accuracy.
DEFAULT_SILENCE_MS = 500
DEFAULT_PREFIX_PADDING_MS = 300
DEFAULT_VAD_THRESHOLD = 0.5


def build_session(
    model: str = DEFAULT_MODEL,
    language: str | None = DEFAULT_LANGUAGE,
    prompt: str | None = None,
    silence_ms: int = DEFAULT_SILENCE_MS,
    prefix_padding_ms: int = DEFAULT_PREFIX_PADDING_MS,
    threshold: float = DEFAULT_VAD_THRESHOLD,
    vad: bool = False,
    noise_reduction: str | None = None,
) -> dict:
    """Session payload for a dictation call.

    `transcription` is the load-bearing key: omit it and the service still runs
    VAD and commits items, but every transcript comes back null.

    `language` matters more than it looks. Each VAD segment is transcribed
    independently, so with no hint the model re-guesses the language on every
    short utterance and a stray segment comes back as Welsh or Malay. Pinning
    it to an ISO-639-1 code stops that.
    """
    transcription: dict = {"model": model}
    if language:
        transcription["language"] = language
    if prompt:
        transcription["prompt"] = prompt

    turn_detection = (
        {
            "type": "server_vad",
            "threshold": threshold,
            "prefix_padding_ms": prefix_padding_ms,
            "silence_duration_ms": silence_ms,
        }
        if vad
        # No VAD: nothing is transcribed until we explicitly commit the buffer,
        # giving one segment for the whole recording.
        else None
    )

    return {
        "type": "transcription",
        "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": 24000},
                # Codex sends None here for transcription; near_field is its
                # conversational setting. Exposed, but off by default.
                "noise_reduction": {"type": noise_reduction} if noise_reduction else None,
                "turn_detection": turn_detection,
                "transcription": transcription,
            }
        },
    }


DEFAULT_SESSION: dict = build_session()

# Codex speaks several protocol revisions; accept every transcript spelling.
DELTA_EVENTS = {
    "conversation.item.input_audio_transcription.delta",
    "conversation.input_transcript.delta",
}
DONE_EVENTS = {
    "conversation.item.input_audio_transcription.completed",
    "conversation.input_transcript.done",
    "conversation.input_transcript.turn_marked",
}


class NegotiationError(RuntimeError):
    pass


def negotiate(offer_sdp: str, auth: ChatGPTAuth, session: dict) -> str:
    """Trade our SDP offer for the server's answer. Returns the answer SDP."""
    url = f"{chatgpt_base_url()}/codex/realtime/calls"
    headers = auth.headers()
    headers["Content-Type"] = "application/json"
    payload = json.dumps({"sdp": offer_sdp, "session": session})
    r = httpx.post(url, content=payload.encode(), headers=headers, timeout=60)
    if r.status_code not in (200, 201):
        raise NegotiationError(f"{r.status_code} from {url}: {r.text[:500]}")
    return r.text


@dataclass
class Transcript:
    """Accumulated result of one session."""

    finals: list[str] = field(default_factory=list)
    partial: str = ""

    @property
    def text(self) -> str:
        out = " ".join(s.strip() for s in self.finals if s.strip())
        return out.strip()


class RealtimeTranscriber:
    """Streams one audio track to the service and collects the transcript."""

    def __init__(
        self,
        auth: ChatGPTAuth,
        session: dict | None = None,
        on_delta: Callable[[str], None] | None = None,
        on_final: Callable[[str], None] | None = None,
        on_event: Callable[[dict], None] | None = None,
    ) -> None:
        self.auth = auth
        self.session = session or DEFAULT_SESSION
        self.on_delta = on_delta
        self.on_final = on_final
        self.on_event = on_event
        self.transcript = Transcript()
        self.pc: RTCPeerConnection | None = None
        self._open = asyncio.Event()
        self._channel = None
        self._segment_done = asyncio.Event()
        self.last_error: dict | None = None

    async def connect(self, track) -> None:
        pc = RTCPeerConnection()
        self.pc = pc

        channel = pc.createDataChannel("oai-events")
        self._channel = channel

        @channel.on("open")
        def _on_open() -> None:
            self._open.set()

        @channel.on("message")
        def _on_message(raw) -> None:
            try:
                event = json.loads(raw)
            except (ValueError, TypeError):
                return
            self._handle(event)

        pc.addTrack(track)

        offer = await pc.createOffer()
        # aiortc completes ICE gathering inside setLocalDescription, so
        # pc.localDescription.sdp below is already a full, non-trickle offer.
        await pc.setLocalDescription(offer)

        answer_sdp = await asyncio.to_thread(
            negotiate, pc.localDescription.sdp, self.auth, self.session
        )
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))

    def _handle(self, event: dict) -> None:
        if self.on_event:
            self.on_event(event)
        etype = event.get("type", "")

        if etype in DELTA_EVENTS:
            delta = event.get("delta") or ""
            if delta:
                self.transcript.partial += delta
                if self.on_delta:
                    self.on_delta(delta)

        elif etype in DONE_EVENTS:
            text = event.get("transcript") or self.transcript.partial
            self.transcript.partial = ""
            if text:
                self.transcript.finals.append(text)
                if self.on_final:
                    self.on_final(text)
            self._segment_done.set()

        elif etype == "error":
            # Raising here would only be swallowed by the data-channel
            # callback, and it would strand commit() waiting on a segment that
            # is never coming. Record it and release the waiter instead.
            self.last_error = event.get("error") or event
            self._segment_done.set()

    async def wait_until_open(self, timeout: float = 30.0) -> None:
        await asyncio.wait_for(self._open.wait(), timeout=timeout)

    def send(self, event: dict) -> None:
        """Push a client event up the same data channel transcripts come down."""
        if self._channel is None or self._channel.readyState != "open":
            raise RuntimeError("data channel is not open")
        self._channel.send(json.dumps(event))

    async def commit(self, timeout: float = 20.0) -> None:
        """Close the audio buffer and wait for its transcript.

        Only meaningful with `vad=False`, where nothing is transcribed until
        asked. The whole recording becomes one segment, so the model sees the
        full utterance as context instead of a string of isolated fragments.
        """
        self._segment_done.clear()
        self.send({"type": "input_audio_buffer.commit"})
        try:
            await asyncio.wait_for(self._segment_done.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass

    async def close(self) -> None:
        # Any trailing partial is still real speech; don't discard it.
        if self.transcript.partial.strip():
            self.transcript.finals.append(self.transcript.partial)
            self.transcript.partial = ""
        if self.pc:
            await self.pc.close()
            self.pc = None
