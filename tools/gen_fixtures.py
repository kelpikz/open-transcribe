"""Record the Python's exact behaviour as JSON fixtures.

These are the oracle for the TypeScript port. The live endpoint is dead, so
network behaviour cannot be captured; everything here is pure logic, which is
where port regressions actually hide. Deleted along with the Python once the
port is verified — the fixtures themselves survive.

    python tools/gen_fixtures.py
"""

from __future__ import annotations

import base64
import io
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from codex_audio import auth as auth_mod
from codex_audio import cli as cli_mod
from codex_audio import realtime as rt

OUT = Path("fixtures")
OUT.mkdir(exist_ok=True)


def dump(name: str, obj) -> None:
    path = OUT / f"{name}.json"
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  wrote {path} ({len(json.dumps(obj))} bytes)")


# ---------------------------------------------------------------- build_session
def gen_sessions() -> None:
    cases = [
        {"label": "defaults", "kwargs": {}},
        {"label": "no-language", "kwargs": {"language": None}},
        {"label": "mini-model", "kwargs": {"model": "gpt-4o-mini-transcribe"}},
        {"label": "whisper", "kwargs": {"model": "whisper-1"}},
        {"label": "with-prompt", "kwargs": {"prompt": "Ajith, codex, aiortc"}},
        {"label": "vad-on", "kwargs": {"vad": True}},
        {"label": "vad-on-tuned", "kwargs": {"vad": True, "silence_ms": 900, "threshold": 0.7, "prefix_padding_ms": 120}},
        {"label": "near-field", "kwargs": {"noise_reduction": "near_field"}},
        {"label": "far-field-vad", "kwargs": {"noise_reduction": "far_field", "vad": True}},
        {"label": "everything", "kwargs": {
            "model": "whisper-1", "language": "hi", "prompt": "p",
            "silence_ms": 250, "prefix_padding_ms": 50, "threshold": 0.1,
            "vad": True, "noise_reduction": "near_field",
        }},
        {"label": "empty-prompt-falsy", "kwargs": {"prompt": ""}},
        {"label": "empty-language-falsy", "kwargs": {"language": ""}},
    ]
    out = [{"label": c["label"], "kwargs": c["kwargs"], "result": rt.build_session(**c["kwargs"])} for c in cases]
    dump("build_session", out)

    dump("realtime_constants", {
        "DEFAULT_MODEL": rt.DEFAULT_MODEL,
        "CODEX_MODEL": rt.CODEX_MODEL,
        "TRANSCRIBE_MODELS": rt.TRANSCRIBE_MODELS,
        "DEFAULT_LANGUAGE": rt.DEFAULT_LANGUAGE,
        "DEFAULT_SILENCE_MS": rt.DEFAULT_SILENCE_MS,
        "DEFAULT_PREFIX_PADDING_MS": rt.DEFAULT_PREFIX_PADDING_MS,
        "DEFAULT_VAD_THRESHOLD": rt.DEFAULT_VAD_THRESHOLD,
        "DELTA_EVENTS": sorted(rt.DELTA_EVENTS),
        "DONE_EVENTS": sorted(rt.DONE_EVENTS),
        "DEFAULT_SESSION": rt.DEFAULT_SESSION,
    })


# ------------------------------------------------------------------- jwt / auth
def _mk_jwt(payload: dict, *, pad: bool = True) -> str:
    raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    if not pad:
        raw = raw.rstrip("=")
    return f"header.{raw}.sig"


def gen_jwt() -> None:
    cases = [
        {"label": "exp-int", "token": _mk_jwt({"exp": 2000000000})},
        {"label": "exp-float", "token": _mk_jwt({"exp": 1999999999.5})},
        {"label": "exp-unpadded", "token": _mk_jwt({"exp": 1234567890}, pad=False)},
        {"label": "exp-string-numeric", "token": _mk_jwt({"exp": "1700000000"})},
        {"label": "no-exp-claim", "token": _mk_jwt({"sub": "x"})},
        {"label": "not-a-jwt", "token": "totally-not-a-jwt"},
        {"label": "empty", "token": ""},
        {"label": "one-segment", "token": "onlyonesegment"},
        {"label": "bad-base64", "token": "header.!!!!not-base64!!!!.sig"},
        {"label": "extra-claims", "token": _mk_jwt({"exp": 1800000000, "sub": "u", "aud": ["a", "b"]})},
    ]
    dump("jwt_exp", [{"label": c["label"], "token": c["token"], "exp": auth_mod._jwt_exp(c["token"])} for c in cases])

    # headers() across auth shapes
    hdr_cases = [
        {"label": "full", "kw": {"access_token": "AT", "refresh_token": "RT", "account_id": "ACC", "id_token": "IT"}},
        {"label": "no-account", "kw": {"access_token": "AT", "refresh_token": "RT", "account_id": None}},
        {"label": "empty-account", "kw": {"access_token": "AT", "refresh_token": None, "account_id": ""}},
    ]
    dump("auth_headers", [
        {"label": c["label"], "input": c["kw"], "headers": auth_mod.ChatGPTAuth(**c["kw"]).headers()}
        for c in hdr_cases
    ])

    # expired: relative to a pinned clock so the fixture is stable
    now = 1_700_000_000.0
    real_time = time.time
    time.time = lambda: now  # type: ignore[assignment]
    try:
        exp_cases = [
            {"label": "expires-far-future", "token": _mk_jwt({"exp": now + 3600})},
            {"label": "expires-in-90s", "token": _mk_jwt({"exp": now + 90})},
            {"label": "expires-in-30s-inside-skew", "token": _mk_jwt({"exp": now + 30})},
            {"label": "expires-exactly-60s", "token": _mk_jwt({"exp": now + 60})},
            {"label": "already-expired", "token": _mk_jwt({"exp": now - 10})},
            {"label": "unparseable-token", "token": "nope"},
        ]
        dump("auth_expired", {
            "now": now,
            "skew_seconds": 60,
            "cases": [
                {"label": c["label"], "expired": auth_mod.ChatGPTAuth(c["token"], None, None).expired}
                for c in exp_cases
            ],
        })
    finally:
        time.time = real_time  # type: ignore[assignment]

    dump("base_url", {
        "default": auth_mod.DEFAULT_CHATGPT_BASE_URL,
        "token_url": auth_mod.TOKEN_URL,
        "client_id": auth_mod.CLIENT_ID,
        "note": "chatgpt_base_url() reads CODEX_CHATGPT_BASE_URL and rstrips trailing slashes",
        "rstrip_cases": [
            {"env": "https://x.test/api", "expect": "https://x.test/api"},
            {"env": "https://x.test/api/", "expect": "https://x.test/api"},
            {"env": "https://x.test/api///", "expect": "https://x.test/api"},
        ],
    })


# -------------------------------------------------------------------- transcript
def gen_transcript() -> None:
    cases = [
        {"label": "empty", "finals": []},
        {"label": "single", "finals": ["Hello world."]},
        {"label": "joins-with-space", "finals": ["One.", "Two."]},
        {"label": "strips-each", "finals": ["  padded  ", "\ttabbed\t"]},
        {"label": "drops-blank", "finals": ["real", "   ", "", "also real"]},
        {"label": "all-blank", "finals": ["  ", ""]},
        {"label": "newlines-inside", "finals": ["line one\nline two"]},
        {"label": "unicode", "finals": ["café", "naïve — dash"]},
    ]
    dump("transcript_text", [
        {"label": c["label"], "finals": c["finals"], "text": rt.Transcript(finals=list(c["finals"])).text}
        for c in cases
    ])


# ---------------------------------------------------------------- event dispatch
def gen_events() -> None:
    """Drive _handle over synthetic streams; record callbacks and final state.

    Covers every branch: both delta spellings, all three done spellings,
    transcript-vs-partial fallback, empty deltas, error events, and the
    close() rescue of a trailing partial.
    """
    streams = [
        {
            "label": "delta-then-completed",
            "events": [
                {"type": "conversation.item.input_audio_transcription.delta", "delta": "Hel"},
                {"type": "conversation.item.input_audio_transcription.delta", "delta": "lo"},
                {"type": "conversation.item.input_audio_transcription.completed", "transcript": "Hello."},
            ],
        },
        {
            "label": "alt-spelling-v2",
            "events": [
                {"type": "conversation.input_transcript.delta", "delta": "abc"},
                {"type": "conversation.input_transcript.done", "transcript": "ABC."},
            ],
        },
        {
            "label": "turn-marked-done",
            "events": [
                {"type": "conversation.input_transcript.delta", "delta": "xy"},
                {"type": "conversation.input_transcript.turn_marked", "transcript": "XY."},
            ],
        },
        {
            "label": "done-without-transcript-falls-back-to-partial",
            "events": [
                {"type": "conversation.item.input_audio_transcription.delta", "delta": "partial text"},
                {"type": "conversation.item.input_audio_transcription.completed"},
            ],
        },
        {
            "label": "done-with-null-transcript-falls-back",
            "events": [
                {"type": "conversation.item.input_audio_transcription.delta", "delta": "fallback"},
                {"type": "conversation.item.input_audio_transcription.completed", "transcript": None},
            ],
        },
        {
            "label": "empty-deltas-ignored",
            "events": [
                {"type": "conversation.item.input_audio_transcription.delta", "delta": ""},
                {"type": "conversation.item.input_audio_transcription.delta"},
                {"type": "conversation.item.input_audio_transcription.delta", "delta": None},
                {"type": "conversation.item.input_audio_transcription.delta", "delta": "kept"},
                {"type": "conversation.item.input_audio_transcription.completed", "transcript": "Kept."},
            ],
        },
        {
            "label": "done-with-nothing-appends-nothing",
            "events": [{"type": "conversation.item.input_audio_transcription.completed"}],
        },
        {
            "label": "multi-segment",
            "events": [
                {"type": "conversation.item.input_audio_transcription.completed", "transcript": "First."},
                {"type": "conversation.item.input_audio_transcription.completed", "transcript": "Second."},
                {"type": "conversation.item.input_audio_transcription.completed", "transcript": "Third."},
            ],
        },
        {
            "label": "error-event",
            "events": [{"type": "error", "error": {"code": "boom", "message": "bad"}}],
        },
        {
            "label": "error-event-without-error-key",
            "events": [{"type": "error", "message": "flat"}],
        },
        {
            "label": "unknown-events-ignored",
            "events": [
                {"type": "session.created"},
                {"type": "input_audio_buffer.speech_started"},
                {"type": ""},
                {},
                {"type": "conversation.item.input_audio_transcription.completed", "transcript": "Only this."},
            ],
        },
        {
            "label": "trailing-partial-rescued-on-close",
            "events": [{"type": "conversation.item.input_audio_transcription.delta", "delta": "stranded words"}],
            "close": True,
        },
        {
            "label": "trailing-whitespace-partial-not-rescued",
            "events": [{"type": "conversation.item.input_audio_transcription.delta", "delta": "   "}],
            "close": True,
        },
    ]

    out = []
    for s in streams:
        deltas: list[str] = []
        finals: list[str] = []
        seen: list[str] = []
        tx = rt.RealtimeTranscriber.__new__(rt.RealtimeTranscriber)
        tx.on_delta = deltas.append
        tx.on_final = finals.append
        tx.on_event = lambda e: seen.append(e.get("type", ""))
        tx.transcript = rt.Transcript()
        tx.last_error = None
        import asyncio as _a
        tx._segment_done = _a.Event()

        for ev in s["events"]:
            tx._handle(ev)

        if s.get("close"):
            # close()'s partial-rescue branch, without touching the peer connection
            if tx.transcript.partial.strip():
                tx.transcript.finals.append(tx.transcript.partial)
                tx.transcript.partial = ""

        out.append({
            "label": s["label"],
            "events": s["events"],
            "closed": bool(s.get("close")),
            "on_delta_calls": deltas,
            "on_final_calls": finals,
            "on_event_types": seen,
            "finals": tx.transcript.finals,
            "partial": tx.transcript.partial,
            "text": tx.transcript.text,
            "last_error": tx.last_error,
            "segment_done_set": tx._segment_done.is_set(),
        })
    dump("event_dispatch", out)


# ---------------------------------------------------------------------- renderer
def gen_renderer() -> None:
    """Capture exact stderr bytes for scripted render sequences."""
    scripts = [
        {"label": "delta-then-final", "ops": [["delta", "Hel"], ["delta", "lo"], ["final", "Hello."]]},
        {"label": "status-and-done", "ops": [["status", "transcribing…"], ["done", None]]},
        {"label": "final-clears-live", "ops": [["delta", "abc"], ["final", "ABC."], ["done", None]]},
        {"label": "status-clears-live", "ops": [["delta", "abc"], ["status", "msg"]]},
        {"label": "long-delta-truncates-to-110", "ops": [["delta", "x" * 200], ["final", "done"]]},
        {"label": "final-only", "ops": [["final", "Just this."]]},
        {"label": "multiple-finals", "ops": [["final", "One."], ["final", "Two."], ["done", None]]},
    ]

    modes = [
        {"label": "tty-color", "enabled": True, "interactive": True, "color": True, "encoding": "utf-8"},
        {"label": "tty-nocolor", "enabled": True, "interactive": True, "color": False, "encoding": "utf-8"},
        {"label": "piped", "enabled": True, "interactive": False, "color": False, "encoding": "utf-8"},
        {"label": "quiet", "enabled": False, "interactive": True, "color": True, "encoding": "utf-8"},
        {"label": "cp1252-glyph-fallback", "enabled": True, "interactive": True, "color": True, "encoding": "cp1252"},
        {"label": "ascii-glyph-fallback", "enabled": True, "interactive": True, "color": True, "encoding": "ascii"},
    ]

    class FakeStderr:
        """StringIO with a settable `encoding`, which Renderer sniffs for glyphs."""

        def __init__(self, encoding: str) -> None:
            self.encoding = encoding
            self._buf = io.StringIO()

        def write(self, s: str) -> int:
            return self._buf.write(s)

        def flush(self) -> None:
            pass

        def isatty(self) -> bool:
            return False

        def getvalue(self) -> str:
            return self._buf.getvalue()

    out = []
    real_stderr = sys.stderr
    for mode in modes:
        for script in scripts:
            buf = FakeStderr(mode["encoding"])
            sys.stderr = buf  # type: ignore[assignment]
            try:
                r = cli_mod.Renderer(
                    enabled=mode["enabled"], interactive=mode["interactive"], color=mode["color"]
                )
                for op, arg in script["ops"]:
                    if op == "delta":
                        r.delta(arg)
                    elif op == "final":
                        r.final(arg)
                    elif op == "status":
                        r.status(arg)
                    elif op == "done":
                        r.done()
                captured = buf.getvalue()
                glyphs = [r.g_live, r.g_ok, r.g_rule]
                buffered = r.buf
            finally:
                sys.stderr = real_stderr
            out.append({
                "mode": mode["label"],
                "script": script["label"],
                "ops": script["ops"],
                "glyphs": glyphs,
                "buf_after": buffered,
                "stderr": captured,
            })
    dump("renderer", out)


# ------------------------------------------------------------------ arg parsing
def gen_args() -> None:
    ok_cases = [
        [],
        ["file.wav"],
        ["--stream"],
        ["--json"],
        ["-q"],
        ["--quiet"],
        ["-l", "hi"],
        ["--language", "auto"],
        ["--model", "whisper-1"],
        ["--device", "3"],
        ["--device", "Microphone (Realtek)"],
        ["--silence-ms", "900"],
        ["--noise-reduction", "near_field"],
        ["--noise-reduction", "none"],
        ["--drain", "0"],
        ["--drain", "4.5"],
        ["--no-partials", "--no-color"],
        ["--raw-events"],
        ["--list-devices"],
        ["--session", '{"type":"transcription"}'],
        ["in.mp3", "--stream", "--json", "-l", "es", "--drain", "1.5"],
    ]
    out_ok = []
    for argv in ok_cases:
        ns = cli_mod.build_parser().parse_args(argv)
        out_ok.append({"argv": argv, "parsed": vars(ns)})
    dump("args_ok", out_ok)

    err_cases = [
        ["--noise-reduction", "sideways"],
        ["--silence-ms", "abc"],
        ["--drain", "xyz"],
        ["--nope"],
        ["a.wav", "b.wav"],
    ]
    out_err = []
    for argv in err_cases:
        buf = io.StringIO()
        real = sys.stderr
        sys.stderr = buf
        code = None
        try:
            cli_mod.build_parser().parse_args(argv)
        except SystemExit as e:
            code = e.code
        finally:
            sys.stderr = real
        out_err.append({"argv": argv, "exit_code": code, "stderr_tail": buf.getvalue().strip().split("\n")[-1]})
    dump("args_err", out_err)


# ------------------------------------------------------------ transcribe route
def gen_transcribe() -> None:
    """The /transcribe upload route: MIME mapping and request construction."""
    from codex_audio import transcribe as tr

    ext_cases = [
        "a.wav", "a.WAV", "a.mp3", "a.m4a", "a.mp4", "a.webm", "a.weba",
        "a.ogg", "a.oga", "a.flac", "a.aac",
        "a.opus", "a.aiff", "a.txt", "a.bin", "noextension",
        "dotted.name.wav", "UPPER.MP3", "a.Mp4",
    ]
    dump("content_type_for", [
        {"path": p, "content_type": tr.content_type_for(p)} for p in ext_cases
    ])

    dump("transcribe_constants", {
        "TRANSCRIBE_URL_SUFFIX": tr.TRANSCRIBE_URL_SUFFIX,
        "DEFAULT_LANGUAGE": tr.DEFAULT_LANGUAGE,
        "DEFAULT_MODEL": tr.DEFAULT_MODEL,
        "TRANSCRIBE_MODELS": tr.TRANSCRIBE_MODELS,
    })

    # Request construction, captured without touching the network.
    import httpx as _httpx

    captured: list[dict] = []

    class _Resp:
        status_code = 200

        def json(self):
            return {"text": "stub"}

        text = ""

    def fake_post(url, **kw):
        files = kw.get("files") or {}
        fname, fdata, ctype = files.get("file", (None, b"", None))
        captured.append({
            "url": url,
            "header_names": sorted((kw.get("headers") or {}).keys()),
            "form": kw.get("data"),
            "file_name": fname,
            "file_bytes": len(fdata) if isinstance(fdata, (bytes, bytearray)) else None,
            "file_content_type": ctype,
            "timeout": kw.get("timeout"),
        })
        return _Resp()

    real_post = _httpx.post
    real_load = tr.ChatGPTAuth.load
    stub_auth = tr.ChatGPTAuth(access_token="AT", refresh_token="RT", account_id="ACC")
    tr.ChatGPTAuth.load = classmethod(lambda cls: stub_auth)  # type: ignore[assignment]
    _httpx.post = fake_post  # type: ignore[assignment]
    try:
        lang_cases = ["en", "hi", None, "auto", ""]
        for lang in lang_cases:
            tr.transcribe_audio(
                b"RIFFfake", filename="codex-audio.wav",
                content_type="audio/wav", language=lang,
            )
    finally:
        _httpx.post = real_post  # type: ignore[assignment]
        tr.ChatGPTAuth.load = real_load  # type: ignore[assignment]

    dump("transcribe_requests", [
        {"language": lang, "request": cap}
        for lang, cap in zip(["en", "hi", None, "auto", ""], captured)
    ])

    # transcription_headers(), including the drop-empty-values filter
    hdr_cases = [
        {"label": "full", "kw": {"access_token": "AT", "refresh_token": "RT", "account_id": "ACC"}},
        {"label": "no-account-id", "kw": {"access_token": "AT", "refresh_token": "RT", "account_id": None}},
        {"label": "empty-account-id", "kw": {"access_token": "AT", "refresh_token": None, "account_id": ""}},
    ]
    dump("transcription_headers", [
        {"label": c["label"], "input": c["kw"], "headers": auth_mod.ChatGPTAuth(**c["kw"]).transcription_headers()}
        for c in hdr_cases
    ])


# ----------------------------------------------------------- cli stream refusal
def gen_cli_behaviour() -> None:
    """main() paths that do not need the network."""
    out = []
    buf = io.StringIO()
    real = sys.stderr
    sys.stderr = buf
    try:
        code = cli_mod.main(["--stream"])
    finally:
        sys.stderr = real
    out.append({"argv": ["--stream"], "exit_code": code, "stderr": buf.getvalue()})

    buf = io.StringIO()
    sys.stderr = buf
    try:
        code = cli_mod.main(["file.wav", "--stream"])
    finally:
        sys.stderr = real
    out.append({"argv": ["file.wav", "--stream"], "exit_code": code, "stderr": buf.getvalue()})

    dump("cli_stream_refusal", out)


if __name__ == "__main__":
    print("generating fixtures…")
    gen_sessions()
    gen_jwt()
    gen_transcript()
    gen_events()
    gen_renderer()
    gen_args()
    gen_transcribe()
    gen_cli_behaviour()
    print("done")
