"""Tests for codex_audio/transcribe.py.

Run with: .venv/Scripts/python.exe -m pytest tests_py/test_transcribe.py -q

These tests assert against the fixtures in `fixtures/` (the oracle for the
TypeScript port) wherever a fixture exists, and otherwise pin down behaviour
directly from the source (error text, exception breadth, falsy handling) so
the port has something concrete to reproduce.

Nothing here touches the network or the real ~/.codex/auth.json: httpx.post
is always stubbed, and ChatGPTAuth.load/ensure_fresh are always monkeypatched
to return an in-memory stub.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from codex_audio import transcribe as tr
from codex_audio.auth import ChatGPTAuth

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def load_fixture(name: str):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


# ------------------------------------------------------------------ constants


def test_constants_match_fixture():
    fixture = load_fixture("transcribe_constants")
    assert tr.TRANSCRIBE_URL_SUFFIX == fixture["TRANSCRIBE_URL_SUFFIX"]
    assert tr.DEFAULT_LANGUAGE == fixture["DEFAULT_LANGUAGE"]
    assert tr.DEFAULT_MODEL == fixture["DEFAULT_MODEL"]
    assert tr.TRANSCRIBE_MODELS == fixture["TRANSCRIBE_MODELS"]


# ------------------------------------------------------------- content_type_for


@pytest.mark.parametrize("case", load_fixture("content_type_for"), ids=lambda c: c["path"])
def test_content_type_for_matches_fixture(case):
    assert tr.content_type_for(case["path"]) == case["content_type"]


def test_content_type_for_accepts_path_object():
    assert tr.content_type_for(Path("a.wav")) == "audio/wav"


def test_content_type_for_is_case_insensitive_on_extension():
    assert tr.content_type_for("a.WAV") == tr.content_type_for("a.wav")
    assert tr.content_type_for("UPPER.MP3") == "audio/mpeg"


def test_content_type_for_all_dots_before_extension_has_no_suffix():
    # pathlib.PurePath.suffix does `name.lstrip('.')` BEFORE looking for the
    # last dot -- so a name that is entirely dots up to the extension has
    # every leading dot stripped, leaving no "." at all, and therefore no
    # suffix. This is easy to get wrong by reaching for a basename/extname
    # helper that only special-cases a single leading dot (dotfiles like
    # ".bashrc") rather than stripping all of them.
    assert tr.content_type_for("..wav") == "application/octet-stream"
    assert tr.content_type_for("...wav") == "application/octet-stream"
    assert tr.content_type_for("....wav") == "application/octet-stream"
    # A real (non-dot) leading character makes it an ordinary case again.
    assert tr.content_type_for("a...wav") == "audio/wav"


# ------------------------------------------------------------------- auth stub


class _StubAuth:
    """Stands in for ChatGPTAuth.load().ensure_fresh() in tests."""

    def __init__(self, access_token="AT", refresh_token="RT", account_id="ACC"):
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.account_id = account_id
        self.id_token = None

    def ensure_fresh(self):
        return self

    def transcription_headers(self):
        return ChatGPTAuth(
            access_token=self.access_token,
            refresh_token=self.refresh_token,
            account_id=self.account_id,
        ).transcription_headers()


@pytest.fixture(autouse=False)
def stub_auth(monkeypatch):
    stub = _StubAuth()
    monkeypatch.setattr(tr.ChatGPTAuth, "load", classmethod(lambda cls: stub))
    return stub


# -------------------------------------------------------------- request shape


@pytest.mark.parametrize(
    "case",
    load_fixture("transcribe_requests"),
    ids=lambda c: repr(c["language"]),
)
def test_transcribe_audio_request_matches_fixture(monkeypatch, stub_auth, case):
    captured = {}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "stub"}

    def fake_post(url, **kw):
        files = kw.get("files") or {}
        fname, fdata, ctype = files.get("file", (None, b"", None))
        captured["url"] = url
        captured["header_names"] = sorted((kw.get("headers") or {}).keys())
        captured["form"] = kw.get("data")
        captured["file_name"] = fname
        captured["file_bytes"] = len(fdata) if isinstance(fdata, (bytes, bytearray)) else None
        captured["file_content_type"] = ctype
        captured["timeout"] = kw.get("timeout")
        return _Resp()

    monkeypatch.setattr(httpx, "post", fake_post)

    tr.transcribe_audio(
        b"RIFFfake",
        filename="codex-audio.wav",
        content_type="audio/wav",
        language=case["language"],
    )

    expected = case["request"]
    assert captured["url"] == expected["url"]
    assert captured["header_names"] == expected["header_names"]
    assert captured["form"] == expected["form"]
    assert captured["file_name"] == expected["file_name"]
    assert captured["file_bytes"] == expected["file_bytes"]
    assert captured["file_content_type"] == expected["file_content_type"]
    assert captured["timeout"] == expected["timeout"]


def test_transcribe_audio_url_uses_chatgpt_base_url_env(monkeypatch, stub_auth):
    monkeypatch.setenv("CODEX_CHATGPT_BASE_URL", "https://x.test/api/")
    captured = {}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "hi"}

    def fake_post(url, **kw):
        captured["url"] = url
        return _Resp()

    monkeypatch.setattr(httpx, "post", fake_post)
    tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")
    assert captured["url"] == "https://x.test/api/transcribe"


# ---------------------------------------------------------------- transcription_headers fixture


@pytest.mark.parametrize("case", load_fixture("transcription_headers"), ids=lambda c: c["label"])
def test_transcription_headers_matches_fixture(case):
    a = ChatGPTAuth(**case["input"])
    assert a.transcription_headers() == case["headers"]


# ---------------------------------------------------------------------- success


def test_transcribe_audio_returns_text_on_success(monkeypatch, stub_auth):
    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "hello world"}

    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp())
    result = tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")
    assert result == "hello world"


# ---------------------------------------------------------------------- errors


def test_transcribe_audio_raises_on_non_200_with_truncated_body(monkeypatch, stub_auth):
    class _Resp:
        status_code = 500
        text = "x" * 1000

        def json(self):
            raise AssertionError("should not be called on error path")

    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp())
    with pytest.raises(tr.TranscriptionError) as ei:
        tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")
    msg = str(ei.value)
    assert msg.startswith("500 from ")
    assert "/transcribe: " in msg
    # Body truncated to 500 chars.
    assert msg.endswith("x" * 500)
    assert len(msg.rsplit(": ", 1)[1]) == 500


def test_transcribe_audio_truncation_slices_by_unicode_codepoint(monkeypatch, stub_auth):
    # Python strings index by Unicode code point, not UTF-16 code unit, so
    # response.text[:500] on a body with an astral-plane character (e.g. an
    # emoji outside the Basic Multilingual Plane) straddling the boundary
    # keeps the character whole rather than splitting its surrogate pair.
    # This pins the exact codepoint count so a naive UTF-16-based port
    # (JS's String.prototype.slice) can be checked against it.
    body = "a" * 499 + "\U0001F600" + "b" * 20

    class _Resp:
        status_code = 500
        text = body

        def json(self):
            raise AssertionError

    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp())
    with pytest.raises(tr.TranscriptionError) as ei:
        tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")
    snippet = str(ei.value).split(": ", 1)[1]
    assert len(snippet) == 500
    assert snippet.endswith("\U0001F600")
    assert "b" not in snippet


def test_transcribe_audio_raises_on_non_200_short_body(monkeypatch, stub_auth):
    class _Resp:
        status_code = 401
        text = "unauthorized"

        def json(self):
            raise AssertionError

    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp())
    with pytest.raises(tr.TranscriptionError, match="401 from .*: unauthorized"):
        tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")


def test_transcribe_audio_raises_when_body_not_json(monkeypatch, stub_auth):
    class _Resp:
        status_code = 200
        text = "not json"

        def json(self):
            raise ValueError("Expecting value")

    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp())
    with pytest.raises(tr.TranscriptionError, match="did not contain a text field"):
        tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")


def test_transcribe_audio_raises_when_text_field_missing(monkeypatch, stub_auth):
    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"no_text_here": True}

    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp())
    with pytest.raises(tr.TranscriptionError, match="did not contain a text field"):
        tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")


def test_transcribe_audio_raises_when_body_is_not_an_object(monkeypatch, stub_auth):
    # Valid JSON, but not a dict: body["text"] raises TypeError on a list,
    # which the Python's `except (ValueError, KeyError, TypeError)` catches.
    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return ["not", "a", "dict"]

    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp())
    with pytest.raises(tr.TranscriptionError, match="did not contain a text field"):
        tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")


def test_transcribe_audio_raises_when_body_is_a_bare_string(monkeypatch, stub_auth):
    # json() -> "hello": indexing a str with ["text"] raises TypeError too.
    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return "hello"

    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp())
    with pytest.raises(tr.TranscriptionError, match="did not contain a text field"):
        tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")


def test_transcribe_audio_raises_when_text_field_not_a_string(monkeypatch, stub_auth):
    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": 12345}

    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp())
    with pytest.raises(tr.TranscriptionError, match="text was not a string"):
        tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")


def test_transcribe_audio_raises_when_text_field_is_none(monkeypatch, stub_auth):
    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": None}

    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp())
    with pytest.raises(tr.TranscriptionError, match="text was not a string"):
        tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")


def test_transcription_error_is_a_runtime_error():
    assert issubclass(tr.TranscriptionError, RuntimeError)


# -------------------------------------------------------------------- language


def test_transcribe_audio_defaults_language_to_en_when_kwarg_omitted(monkeypatch, stub_auth):
    # transcribe_audio's own signature default (language: str | None = "en")
    # only substitutes when the caller omits the kwarg entirely -- distinct
    # from transcribe_file's identical-looking default one layer up. Every
    # existing caller (transcribe_file, tools/gen_fixtures.py) always passes
    # language= explicitly, so this path was previously untested.
    captured = {}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "x"}

    def fake_post(url, **kw):
        captured["form"] = kw.get("data")
        return _Resp()

    monkeypatch.setattr(httpx, "post", fake_post)
    tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav")
    assert captured["form"] == {"language": "en"}


def test_language_none_omits_form_field(monkeypatch, stub_auth):
    captured = {}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "x"}

    def fake_post(url, **kw):
        captured["form"] = kw.get("data")
        return _Resp()

    monkeypatch.setattr(httpx, "post", fake_post)
    tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav", language=None)
    assert captured["form"] == {}


def test_language_auto_omits_form_field(monkeypatch, stub_auth):
    captured = {}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "x"}

    def fake_post(url, **kw):
        captured["form"] = kw.get("data")
        return _Resp()

    monkeypatch.setattr(httpx, "post", fake_post)
    tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav", language="auto")
    assert captured["form"] == {}


def test_language_explicit_value_included(monkeypatch, stub_auth):
    captured = {}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "x"}

    def fake_post(url, **kw):
        captured["form"] = kw.get("data")
        return _Resp()

    monkeypatch.setattr(httpx, "post", fake_post)
    tr.transcribe_audio(b"data", filename="f.wav", content_type="audio/wav", language="hi")
    assert captured["form"] == {"language": "hi"}


# ----------------------------------------------------------------- transcribe_file


def test_transcribe_file_reads_bytes_and_derives_filename_and_content_type(monkeypatch, stub_auth, tmp_path):
    audio_path = tmp_path / "recording.mp3"
    audio_path.write_bytes(b"mp3-bytes-here")

    captured = {}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "transcribed"}

    def fake_post(url, **kw):
        files = kw.get("files") or {}
        fname, fdata, ctype = files.get("file", (None, b"", None))
        captured["file_name"] = fname
        captured["file_bytes"] = fdata
        captured["file_content_type"] = ctype
        return _Resp()

    monkeypatch.setattr(httpx, "post", fake_post)
    result = tr.transcribe_file(str(audio_path))

    assert result == "transcribed"
    assert captured["file_name"] == "recording.mp3"
    assert captured["file_bytes"] == b"mp3-bytes-here"
    assert captured["file_content_type"] == "audio/mpeg"


def test_transcribe_file_passes_language_through(monkeypatch, stub_auth, tmp_path):
    audio_path = tmp_path / "recording.wav"
    audio_path.write_bytes(b"wav-bytes")

    captured = {}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "x"}

    def fake_post(url, **kw):
        captured["form"] = kw.get("data")
        return _Resp()

    monkeypatch.setattr(httpx, "post", fake_post)
    tr.transcribe_file(str(audio_path), language="hi")
    assert captured["form"] == {"language": "hi"}


def test_transcribe_file_explicit_none_language_omits_form_field(monkeypatch, stub_auth, tmp_path):
    # Distinguishes "language kwarg omitted" (defaults to "en") from
    # "language=None passed explicitly" (forwarded as None, then omitted by
    # transcribe_audio's own falsy check) -- Python's default-argument
    # semantics only substitute "en" when the caller doesn't pass the kwarg
    # at all, not when they pass None.
    audio_path = tmp_path / "recording.wav"
    audio_path.write_bytes(b"wav-bytes")

    captured = {}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "x"}

    def fake_post(url, **kw):
        captured["form"] = kw.get("data")
        return _Resp()

    monkeypatch.setattr(httpx, "post", fake_post)
    tr.transcribe_file(str(audio_path), language=None)
    assert captured["form"] == {}


def test_transcribe_file_default_language_is_en(monkeypatch, stub_auth, tmp_path):
    audio_path = tmp_path / "recording.wav"
    audio_path.write_bytes(b"wav-bytes")

    captured = {}

    class _Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"text": "x"}

    def fake_post(url, **kw):
        captured["form"] = kw.get("data")
        return _Resp()

    monkeypatch.setattr(httpx, "post", fake_post)
    tr.transcribe_file(str(audio_path))
    assert captured["form"] == {"language": "en"}
