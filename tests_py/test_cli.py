"""Tests for codex_audio/cli.py.

Run with: .venv/Scripts/python.exe -m pytest tests_py/test_cli.py -q

Nothing here touches the network, the real ~/.codex/auth.json, or a real
microphone/ffmpeg: record_microphone, transcribe_audio, transcribe_file and
list_devices are always monkeypatched at the cli module's import site.

Where a fixture exists (`renderer.json`, `args_ok.json`, `args_err.json`,
`cli_stream_refusal.json`) these tests assert against it directly, since that
fixture is the oracle the TypeScript port must reproduce. Everything else
(the mic/file async wrappers, main()'s exit codes, stdout/stderr separation)
is pinned down directly from source so the port has something concrete.
"""

from __future__ import annotations

import io
import json
import sys

import pytest

from codex_audio import cli as cli_mod

FIXTURES = __import__("pathlib").Path(__file__).resolve().parents[1] / "fixtures"


def load_fixture(name: str):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


# ------------------------------------------------------------------- Renderer


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


MODES = {
    "tty-color": {"enabled": True, "interactive": True, "color": True, "encoding": "utf-8"},
    "tty-nocolor": {"enabled": True, "interactive": True, "color": False, "encoding": "utf-8"},
    "piped": {"enabled": True, "interactive": False, "color": False, "encoding": "utf-8"},
    "quiet": {"enabled": False, "interactive": True, "color": True, "encoding": "utf-8"},
    "cp1252-glyph-fallback": {"enabled": True, "interactive": True, "color": True, "encoding": "cp1252"},
    "ascii-glyph-fallback": {"enabled": True, "interactive": True, "color": True, "encoding": "ascii"},
}


@pytest.mark.parametrize("case", load_fixture("renderer"), ids=lambda c: f"{c['mode']}/{c['script']}")
def test_renderer_matches_fixture_byte_exact(case, monkeypatch):
    mode = MODES[case["mode"]]
    buf = FakeStderr(mode["encoding"])
    monkeypatch.setattr(sys, "stderr", buf)

    r = cli_mod.Renderer(enabled=mode["enabled"], interactive=mode["interactive"], color=mode["color"])
    for op, arg in case["ops"]:
        if op == "delta":
            r.delta(arg)
        elif op == "final":
            r.final(arg)
        elif op == "status":
            r.status(arg)
        elif op == "done":
            r.done()

    assert buf.getvalue() == case["stderr"]
    assert [r.g_live, r.g_ok, r.g_rule] == case["glyphs"]
    assert r.buf == case["buf_after"]


def test_renderer_glyph_fallback_is_reachable_both_ways():
    # Sanity check independent of the fixture loop above: utf-8 gets the
    # real glyphs, cp1252/ascii (which cannot encode them) get the fallback.
    assert cli_mod.Renderer(True, True, True).g_ok in ("✓", "*")


# --------------------------------------------------------------------- _err


def test_err_writes_to_stderr_with_newline_and_flush(capsys):
    cli_mod._err("hello")
    captured = capsys.readouterr()
    assert captured.err == "hello\n"
    assert captured.out == ""


# --------------------------------------------------------------- build_parser


@pytest.mark.parametrize("case", load_fixture("args_ok"), ids=lambda c: repr(c["argv"]))
def test_build_parser_ok_matches_fixture(case):
    ns = cli_mod.build_parser().parse_args(case["argv"])
    assert vars(ns) == case["parsed"]


@pytest.mark.parametrize("case", load_fixture("args_err"), ids=lambda c: repr(c["argv"]))
def test_build_parser_err_matches_fixture(case, monkeypatch, capsys):
    with pytest.raises(SystemExit) as ei:
        cli_mod.build_parser().parse_args(case["argv"])
    assert ei.value.code == case["exit_code"]
    captured = capsys.readouterr()
    tail = captured.err.strip().split("\n")[-1]
    assert tail == case["stderr_tail"]


# ---------------------------------------------------------------- _render_final


def test_render_final_quiet_suppresses_all_output(capsys):
    args = cli_mod.build_parser().parse_args(["--quiet"])
    cli_mod._render_final("hello", args)
    captured = capsys.readouterr()
    assert captured.err == ""
    assert captured.out == ""


def test_render_final_uses_interactive_false_and_color_from_isatty(monkeypatch, capsys):
    # interactive=False means Renderer never emits the live-line/clear
    # sequence -- _render_final only ever calls final() then done(), and
    # final()'s _clear() is a no-op when interactive is False.
    args = cli_mod.build_parser().parse_args([])
    monkeypatch.setattr(sys.stderr, "isatty", lambda: False, raising=False)
    cli_mod._render_final("hi there", args)
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "hi there" in captured.err
    # No ANSI color codes since isatty() is False -> color=False.
    assert "\x1b[32m" not in captured.err


def test_render_final_no_color_flag_disables_color_even_on_a_tty(monkeypatch, capsys):
    args = cli_mod.build_parser().parse_args(["--no-color"])
    monkeypatch.setattr(sys.stderr, "isatty", lambda: True, raising=False)
    cli_mod._render_final("hi", args)
    captured = capsys.readouterr()
    assert "\x1b[32m" not in captured.err


# -------------------------------------------------------------------- _mic_main


@pytest.mark.asyncio
async def test_mic_main_uploads_as_codex_audio_wav(monkeypatch, capsys):
    captured = {}

    async def fake_record_microphone(device=None):
        captured["device"] = device
        return b"WAVDATA"

    def fake_transcribe_audio(data, *, filename, content_type, language):
        captured["data"] = data
        captured["filename"] = filename
        captured["content_type"] = content_type
        captured["language"] = language
        return "mic transcript"

    monkeypatch.setattr(cli_mod, "record_microphone", fake_record_microphone)
    monkeypatch.setattr(cli_mod, "transcribe_audio", fake_transcribe_audio)

    args = cli_mod.build_parser().parse_args([])
    text = await cli_mod._mic_main(args)

    assert text == "mic transcript"
    assert captured["data"] == b"WAVDATA"
    assert captured["filename"] == "codex-audio.wav"
    assert captured["content_type"] == "audio/wav"
    assert captured["language"] == "en"  # default language, not "auto"

    out = capsys.readouterr()
    assert out.out == ""
    assert "Recording" in out.err
    assert "transcribing" in out.err


@pytest.mark.asyncio
async def test_mic_main_quiet_suppresses_progress_lines(monkeypatch, capsys):
    async def fake_record_microphone(device=None):
        return b"WAVDATA"

    def fake_transcribe_audio(data, *, filename, content_type, language):
        return "x"

    monkeypatch.setattr(cli_mod, "record_microphone", fake_record_microphone)
    monkeypatch.setattr(cli_mod, "transcribe_audio", fake_transcribe_audio)

    args = cli_mod.build_parser().parse_args(["--quiet"])
    await cli_mod._mic_main(args)
    out = capsys.readouterr()
    assert out.err == ""


@pytest.mark.asyncio
async def test_mic_main_language_auto_becomes_none(monkeypatch):
    captured = {}

    async def fake_record_microphone(device=None):
        return b"WAVDATA"

    def fake_transcribe_audio(data, *, filename, content_type, language):
        captured["language"] = language
        return "x"

    monkeypatch.setattr(cli_mod, "record_microphone", fake_record_microphone)
    monkeypatch.setattr(cli_mod, "transcribe_audio", fake_transcribe_audio)

    args = cli_mod.build_parser().parse_args(["--language", "auto", "--quiet"])
    await cli_mod._mic_main(args)
    assert captured["language"] is None


# -------------------------------------------------------------------- _file_main


@pytest.mark.asyncio
async def test_file_main_passes_input_and_language(monkeypatch, capsys):
    captured = {}

    def fake_transcribe_file(path, *, language):
        captured["path"] = path
        captured["language"] = language
        return "file transcript"

    monkeypatch.setattr(cli_mod, "transcribe_file", fake_transcribe_file)

    args = cli_mod.build_parser().parse_args(["in.wav", "-l", "hi"])
    text = await cli_mod._file_main(args)

    assert text == "file transcript"
    assert captured["path"] == "in.wav"
    assert captured["language"] == "hi"

    out = capsys.readouterr()
    assert out.out == ""
    assert "transcribing" in out.err
    assert "Recording" not in out.err


@pytest.mark.asyncio
async def test_file_main_quiet_suppresses_progress(monkeypatch, capsys):
    def fake_transcribe_file(path, *, language):
        return "x"

    monkeypatch.setattr(cli_mod, "transcribe_file", fake_transcribe_file)
    args = cli_mod.build_parser().parse_args(["in.wav", "--quiet"])
    await cli_mod._file_main(args)
    out = capsys.readouterr()
    assert out.err == ""


@pytest.mark.asyncio
async def test_file_main_language_auto_becomes_none(monkeypatch):
    captured = {}

    def fake_transcribe_file(path, *, language):
        captured["language"] = language
        return "x"

    monkeypatch.setattr(cli_mod, "transcribe_file", fake_transcribe_file)
    args = cli_mod.build_parser().parse_args(["in.wav", "--language", "auto", "--quiet"])
    await cli_mod._file_main(args)
    assert captured["language"] is None


# ------------------------------------------------------------------------- main


def test_main_list_devices_prints_and_returns_0_before_anything_else(monkeypatch, capsys):
    monkeypatch.setattr(cli_mod, "list_devices", lambda: "device list here")

    def boom(*a, **kw):
        raise AssertionError("should not reach transcription")

    monkeypatch.setattr(cli_mod, "record_microphone", boom)
    monkeypatch.setattr(cli_mod, "transcribe_file", boom)

    code = cli_mod.main(["--list-devices"])
    assert code == 0
    out = capsys.readouterr()
    assert out.out == "device list here\n"


def test_main_list_devices_wins_even_with_stream_flag(monkeypatch, capsys):
    # --list-devices is checked before --stream in main()'s source order.
    monkeypatch.setattr(cli_mod, "list_devices", lambda: "devices")
    code = cli_mod.main(["--list-devices", "--stream"])
    assert code == 0


@pytest.mark.parametrize("case", load_fixture("cli_stream_refusal"), ids=lambda c: repr(c["argv"]))
def test_main_stream_refusal_matches_fixture(case, monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("should not reach transcription or device work")

    monkeypatch.setattr(cli_mod, "record_microphone", boom)
    monkeypatch.setattr(cli_mod, "transcribe_file", boom)
    monkeypatch.setattr(cli_mod, "transcribe_audio", boom)

    buf = io.StringIO()
    monkeypatch.setattr(sys, "stderr", buf)
    code = cli_mod.main(case["argv"])
    assert code == case["exit_code"]
    assert buf.getvalue() == case["stderr"]


def test_main_device_all_digits_becomes_int(monkeypatch):
    captured = {}

    async def fake_record_microphone(device=None):
        captured["device"] = device
        return b"WAVDATA"

    def fake_transcribe_audio(data, *, filename, content_type, language):
        return "x"

    monkeypatch.setattr(cli_mod, "record_microphone", fake_record_microphone)
    monkeypatch.setattr(cli_mod, "transcribe_audio", fake_transcribe_audio)

    code = cli_mod.main(["--device", "3", "--quiet"])
    assert code == 0
    assert captured["device"] == 3
    assert isinstance(captured["device"], int)


def test_main_device_non_digit_stays_string(monkeypatch):
    captured = {}

    async def fake_record_microphone(device=None):
        captured["device"] = device
        return b"WAVDATA"

    def fake_transcribe_audio(data, *, filename, content_type, language):
        return "x"

    monkeypatch.setattr(cli_mod, "record_microphone", fake_record_microphone)
    monkeypatch.setattr(cli_mod, "transcribe_audio", fake_transcribe_audio)

    code = cli_mod.main(["--device", "Microphone (Realtek)", "--quiet"])
    assert code == 0
    assert captured["device"] == "Microphone (Realtek)"


def test_main_returns_0_and_prints_text_to_stdout_only(monkeypatch, capsys):
    def fake_transcribe_file(path, *, language):
        return "the transcript"

    monkeypatch.setattr(cli_mod, "transcribe_file", fake_transcribe_file)
    code = cli_mod.main(["in.wav", "--quiet"])
    assert code == 0
    out = capsys.readouterr()
    assert out.out == "the transcript\n"
    assert out.err == ""


def test_main_json_flag_emits_json_object(monkeypatch, capsys):
    def fake_transcribe_file(path, *, language):
        return "hello \"world\""

    monkeypatch.setattr(cli_mod, "transcribe_file", fake_transcribe_file)
    code = cli_mod.main(["in.wav", "--quiet", "--json"])
    assert code == 0
    out = capsys.readouterr()
    assert json.loads(out.out) == {"text": "hello \"world\""}


def test_main_keyboard_interrupt_returns_130(monkeypatch):
    def fake_transcribe_file(path, *, language):
        raise KeyboardInterrupt()

    monkeypatch.setattr(cli_mod, "transcribe_file", fake_transcribe_file)
    code = cli_mod.main(["in.wav", "--quiet"])
    assert code == 130


def test_main_generic_exception_returns_1_and_prints_type_and_message(monkeypatch, capsys):
    def fake_transcribe_file(path, *, language):
        raise ValueError("boom")

    monkeypatch.setattr(cli_mod, "transcribe_file", fake_transcribe_file)
    code = cli_mod.main(["in.wav", "--quiet"])
    assert code == 1
    out = capsys.readouterr()
    assert out.out == ""
    assert out.err == "error: ValueError: boom\n"


def test_main_routes_to_file_main_when_input_given(monkeypatch):
    called = {}

    def fake_transcribe_file(path, *, language):
        called["file"] = True
        return "x"

    async def fake_record_microphone(device=None):
        called["mic"] = True
        return b"x"

    monkeypatch.setattr(cli_mod, "transcribe_file", fake_transcribe_file)
    monkeypatch.setattr(cli_mod, "record_microphone", fake_record_microphone)
    cli_mod.main(["in.wav", "--quiet"])
    assert called == {"file": True}


def test_main_routes_to_mic_main_when_no_input(monkeypatch):
    called = {}

    def fake_transcribe_file(path, *, language):
        called["file"] = True
        return "x"

    async def fake_record_microphone(device=None):
        called["mic"] = True
        return b"x"

    def fake_transcribe_audio(data, *, filename, content_type, language):
        return "x"

    monkeypatch.setattr(cli_mod, "transcribe_file", fake_transcribe_file)
    monkeypatch.setattr(cli_mod, "record_microphone", fake_record_microphone)
    monkeypatch.setattr(cli_mod, "transcribe_audio", fake_transcribe_audio)
    cli_mod.main(["--quiet"])
    assert called == {"mic": True}
