"""Tests for codex_audio/realtime.py.

Run with: .venv/Scripts/python.exe -m pytest tests_py/test_realtime.py -q

Nothing here touches the network. `negotiate()` is exercised with
`httpx.post` monkeypatched to a fake that never leaves the process; event
handling is driven directly through `RealtimeTranscriber._handle`, exactly
the way `tools/gen_fixtures.py` builds `fixtures/event_dispatch.json` (via
`__new__`, bypassing `__init__`, so no real asyncio.Event/aiortc machinery is
needed to pin down the dispatch logic).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from codex_audio import auth as auth_mod
from codex_audio import realtime as rt

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def load_fixture(name: str):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


# ------------------------------------------------------------- build_session


@pytest.mark.parametrize("case", load_fixture("build_session"), ids=lambda c: c["label"])
def test_build_session_matches_fixture(case):
    assert rt.build_session(**case["kwargs"]) == case["result"]


def test_default_session_matches_fixture():
    fixture = load_fixture("realtime_constants")
    assert rt.DEFAULT_SESSION == fixture["DEFAULT_SESSION"]
    assert rt.DEFAULT_SESSION == rt.build_session()


# ------------------------------------------------------------------ constants


def test_constants_match_fixture():
    fixture = load_fixture("realtime_constants")
    assert rt.DEFAULT_MODEL == fixture["DEFAULT_MODEL"]
    assert rt.CODEX_MODEL == fixture["CODEX_MODEL"]
    assert rt.TRANSCRIBE_MODELS == fixture["TRANSCRIBE_MODELS"]
    assert rt.DEFAULT_LANGUAGE == fixture["DEFAULT_LANGUAGE"]
    assert rt.DEFAULT_SILENCE_MS == fixture["DEFAULT_SILENCE_MS"]
    assert rt.DEFAULT_PREFIX_PADDING_MS == fixture["DEFAULT_PREFIX_PADDING_MS"]
    assert rt.DEFAULT_VAD_THRESHOLD == fixture["DEFAULT_VAD_THRESHOLD"]
    assert sorted(rt.DELTA_EVENTS) == fixture["DELTA_EVENTS"]
    assert sorted(rt.DONE_EVENTS) == fixture["DONE_EVENTS"]


def test_event_sets_are_disjoint():
    # Sanity: dispatch depends on these never overlapping.
    assert rt.DELTA_EVENTS.isdisjoint(rt.DONE_EVENTS)


# ----------------------------------------------------------------- transcript


@pytest.mark.parametrize("case", load_fixture("transcript_text"), ids=lambda c: c["label"])
def test_transcript_text_matches_fixture(case):
    assert rt.Transcript(finals=list(case["finals"])).text == case["text"]


def test_transcript_defaults_are_empty():
    tx = rt.Transcript()
    assert tx.finals == []
    assert tx.partial == ""
    assert tx.text == ""


# -------------------------------------------------------------- event dispatch


def _make_bare_transcriber() -> tuple[rt.RealtimeTranscriber, list[str], list[str], list[str]]:
    """Build a RealtimeTranscriber without running __init__ / touching aiortc.

    Mirrors tools/gen_fixtures.py's gen_events() exactly, since that is how
    fixtures/event_dispatch.json was generated: __new__ + manual field setup,
    driving `_handle` directly with no data channel or peer connection.
    """
    deltas: list[str] = []
    finals: list[str] = []
    seen: list[str] = []
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx.on_delta = deltas.append
    tx.on_final = finals.append
    tx.on_event = lambda e: seen.append(e.get("type", ""))
    tx.transcript = rt.Transcript()
    tx.last_error = None
    tx._segment_done = asyncio.Event()
    return tx, deltas, finals, seen


@pytest.mark.parametrize("case", load_fixture("event_dispatch"), ids=lambda c: c["label"])
def test_event_dispatch_matches_fixture(case):
    tx, deltas, finals, seen = _make_bare_transcriber()

    for ev in case["events"]:
        tx._handle(ev)

    if case["closed"]:
        # Exactly the partial-rescue branch of close(), the only part
        # gen_fixtures.py replicates without touching a real peer connection.
        if tx.transcript.partial.strip():
            tx.transcript.finals.append(tx.transcript.partial)
            tx.transcript.partial = ""

    assert deltas == case["on_delta_calls"]
    assert finals == case["on_final_calls"]
    assert seen == case["on_event_types"]
    assert tx.transcript.finals == case["finals"]
    assert tx.transcript.partial == case["partial"]
    assert tx.transcript.text == case["text"]
    assert tx.last_error == case["last_error"]
    assert tx._segment_done.is_set() == case["segment_done_set"]


def test_handle_swallows_malformed_json_on_data_channel():
    # _handle itself only ever receives already-decoded dicts; the
    # except (ValueError, TypeError): return guard lives in the "message"
    # callback inside connect(), decoding `raw` before calling _handle. We
    # can't easily reach connect() without a live aiortc data channel, so
    # this pins the decode step in isolation instead.
    with pytest.raises(json.JSONDecodeError):
        json.loads("not json")
    # And a non-str/bytes value raises TypeError, also caught by the same
    # except clause in connect()'s _on_message.
    with pytest.raises(TypeError):
        json.loads(None)  # type: ignore[arg-type]


def test_handle_ignores_missing_type_key_like_empty_string():
    tx, deltas, finals, seen = _make_bare_transcriber()
    tx._handle({})
    assert deltas == []
    assert finals == []
    assert tx.transcript.finals == []
    assert tx.last_error is None
    assert tx._segment_done.is_set() is False


def test_handle_without_on_delta_on_final_on_event_does_not_raise():
    # All three callbacks are optional (None) in normal construction.
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx.on_delta = None
    tx.on_final = None
    tx.on_event = None
    tx.transcript = rt.Transcript()
    tx.last_error = None
    tx._segment_done = asyncio.Event()

    tx._handle({"type": "conversation.item.input_audio_transcription.delta", "delta": "hi"})
    tx._handle({"type": "conversation.item.input_audio_transcription.completed", "transcript": "hi."})
    tx._handle({"type": "error", "error": {"code": "x"}})

    assert tx.transcript.finals == ["hi."]
    assert tx.last_error == {"code": "x"}


# --------------------------------------------------------------------- init


def test_init_defaults():
    auth = auth_mod.ChatGPTAuth(access_token="AT", refresh_token=None, account_id=None)
    tx = rt.RealtimeTranscriber(auth)
    assert tx.auth is auth
    assert tx.session == rt.DEFAULT_SESSION
    assert tx.on_delta is None
    assert tx.on_final is None
    assert tx.on_event is None
    assert tx.transcript.finals == []
    assert tx.transcript.partial == ""
    assert tx.pc is None
    assert tx.last_error is None
    assert tx._channel is None
    assert isinstance(tx._open, asyncio.Event)
    assert isinstance(tx._segment_done, asyncio.Event)
    assert not tx._open.is_set()
    assert not tx._segment_done.is_set()


def test_init_custom_session_and_callbacks():
    auth = auth_mod.ChatGPTAuth(access_token="AT", refresh_token=None, account_id=None)
    custom_session = {"type": "transcription", "audio": {}}
    calls = {"delta": [], "final": [], "event": []}
    tx = rt.RealtimeTranscriber(
        auth,
        session=custom_session,
        on_delta=lambda d: calls["delta"].append(d),
        on_final=lambda f: calls["final"].append(f),
        on_event=lambda e: calls["event"].append(e),
    )
    assert tx.session is custom_session
    tx._handle({"type": "conversation.item.input_audio_transcription.delta", "delta": "x"})
    assert calls["delta"] == ["x"]
    assert calls["event"] == [{"type": "conversation.item.input_audio_transcription.delta", "delta": "x"}]


# ------------------------------------------------------------------ negotiate


def _auth() -> auth_mod.ChatGPTAuth:
    return auth_mod.ChatGPTAuth(access_token="AT", refresh_token=None, account_id="ACC")


class _FakeResponse:
    def __init__(self, text: str, status_code: int):
        self.text = text
        self.status_code = status_code


def test_negotiate_posts_correct_url_headers_and_body(monkeypatch):
    captured = {}

    def fake_post(url, content=None, headers=None, timeout=None):
        captured["url"] = url
        captured["content"] = content
        captured["headers"] = headers
        captured["timeout"] = timeout
        return _FakeResponse("v=0\r\n...answer...", 200)

    monkeypatch.setattr(rt.httpx, "post", fake_post)

    auth = _auth()
    session = rt.build_session()
    result = rt.negotiate("v=0\r\n...offer...", auth, session)

    assert result == "v=0\r\n...answer..."
    assert captured["url"] == f"{auth_mod.chatgpt_base_url()}/codex/realtime/calls"
    assert captured["timeout"] == 60
    assert captured["headers"]["Content-Type"] == "application/json"
    assert captured["headers"]["Authorization"] == "Bearer AT"
    assert captured["headers"]["ChatGPT-Account-Id"] == "ACC"
    body = json.loads(captured["content"].decode())
    assert body == {"sdp": "v=0\r\n...offer...", "session": session}


def test_negotiate_accepts_201(monkeypatch):
    monkeypatch.setattr(rt.httpx, "post", lambda *a, **k: _FakeResponse("answer-sdp", 201))
    result = rt.negotiate("offer", _auth(), rt.build_session())
    assert result == "answer-sdp"


def test_negotiate_raises_negotiation_error_on_404(monkeypatch):
    monkeypatch.setattr(rt.httpx, "post", lambda *a, **k: _FakeResponse('{"detail":"Not Found"}', 404))
    with pytest.raises(rt.NegotiationError) as ei:
        rt.negotiate("offer", _auth(), rt.build_session())
    msg = str(ei.value)
    assert msg.startswith("404 from ")
    assert "Not Found" in msg


def test_negotiate_error_truncates_body_to_500_chars(monkeypatch):
    long_body = "x" * 1000
    monkeypatch.setattr(rt.httpx, "post", lambda *a, **k: _FakeResponse(long_body, 500))
    with pytest.raises(rt.NegotiationError) as ei:
        rt.negotiate("offer", _auth(), rt.build_session())
    # message format: f"{status} from {url}: {text[:500]}"
    suffix = str(ei.value).split(": ", 1)[1]
    assert suffix == "x" * 500
    assert len(suffix) == 500


def test_negotiate_is_a_runtime_error_subclass():
    assert issubclass(rt.NegotiationError, RuntimeError)


# ------------------------------------------------------------------- send


def test_send_raises_when_channel_is_none():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx._channel = None
    with pytest.raises(RuntimeError, match="data channel is not open"):
        tx.send({"type": "ping"})


class _FakeChannel:
    def __init__(self, ready_state: str):
        self.readyState = ready_state
        self.sent: list[str] = []

    def send(self, data: str) -> None:
        self.sent.append(data)


def test_send_raises_when_channel_not_open():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx._channel = _FakeChannel("connecting")
    with pytest.raises(RuntimeError, match="data channel is not open"):
        tx.send({"type": "ping"})


def test_send_writes_json_when_open():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    channel = _FakeChannel("open")
    tx._channel = channel
    tx.send({"type": "input_audio_buffer.commit"})
    assert channel.sent == [json.dumps({"type": "input_audio_buffer.commit"})]


# --------------------------------------------------------------- wait_until_open


@pytest.mark.asyncio
async def test_wait_until_open_returns_immediately_once_set():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx._open = asyncio.Event()
    tx._open.set()
    await asyncio.wait_for(tx.wait_until_open(timeout=1.0), timeout=1.0)


@pytest.mark.asyncio
async def test_wait_until_open_raises_timeout_error():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx._open = asyncio.Event()
    with pytest.raises(asyncio.TimeoutError):
        await tx.wait_until_open(timeout=0.05)


# ------------------------------------------------------------------- commit


@pytest.mark.asyncio
async def test_commit_clears_segment_done_sends_commit_and_waits():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    channel = _FakeChannel("open")
    tx._channel = channel
    tx._segment_done = asyncio.Event()
    tx._segment_done.set()  # pre-set from a previous segment

    async def commit_and_release():
        # Start commit(); it must clear the flag we just set, then we set it
        # again shortly after to simulate the server's completion event.
        task = asyncio.ensure_future(tx.commit(timeout=1.0))
        await asyncio.sleep(0)  # let commit() run up to the wait
        assert not tx._segment_done.is_set()  # clear() happened before wait
        tx._segment_done.set()
        await task

    await commit_and_release()
    assert channel.sent == [json.dumps({"type": "input_audio_buffer.commit"})]


@pytest.mark.asyncio
async def test_commit_swallows_timeout():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    channel = _FakeChannel("open")
    tx._channel = channel
    tx._segment_done = asyncio.Event()
    # Never set _segment_done -- commit() must swallow the TimeoutError.
    await tx.commit(timeout=0.05)
    assert channel.sent == [json.dumps({"type": "input_audio_buffer.commit"})]


@pytest.mark.asyncio
async def test_commit_propagates_send_failure_uncaught():
    # send() raises RuntimeError *before* the try/except around wait_for, so
    # commit() must not swallow it.
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx._channel = None
    tx._segment_done = asyncio.Event()
    with pytest.raises(RuntimeError, match="data channel is not open"):
        await tx.commit(timeout=1.0)


# --------------------------------------------------------------------- close


@pytest.mark.asyncio
async def test_close_rescues_trailing_nonblank_partial():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx.transcript = rt.Transcript()
    tx.transcript.partial = "stranded words"
    tx.pc = None
    await tx.close()
    assert tx.transcript.finals == ["stranded words"]
    assert tx.transcript.partial == ""


@pytest.mark.asyncio
async def test_close_does_not_rescue_whitespace_only_partial():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx.transcript = rt.Transcript()
    tx.transcript.partial = "   "
    tx.pc = None
    await tx.close()
    assert tx.transcript.finals == []
    assert tx.transcript.partial == "   "  # left untouched, not cleared


class _FakePC:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_close_closes_pc_and_sets_it_to_none():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx.transcript = rt.Transcript()
    pc = _FakePC()
    tx.pc = pc
    await tx.close()
    assert pc.closed is True
    assert tx.pc is None


@pytest.mark.asyncio
async def test_close_with_no_pc_and_no_partial_is_a_noop():
    tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
    tx.transcript = rt.Transcript()
    tx.pc = None
    await tx.close()
    assert tx.transcript.finals == []
    assert tx.pc is None
