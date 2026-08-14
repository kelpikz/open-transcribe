"""Tests for codex_audio/auth.py.

Run with: .venv/Scripts/python.exe -m pytest tests_py/test_auth.py -q

These tests assert against the fixtures in `fixtures/` (the oracle for the
TypeScript port) wherever a fixture exists, and otherwise pin down behaviour
directly from the source (file-format, merge-on-save, refresh fallbacks,
error messages) so the port has something concrete to reproduce.

Nothing here touches the user's real ~/.codex/auth.json or the network:
CODEX_HOME is always monkeypatched to a tmp_path, and httpx.post is always
stubbed for refresh().
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
import pytest

from codex_audio import auth as auth_mod

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def load_fixture(name: str):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


# --------------------------------------------------------------- codex_home


def test_codex_home_defaults_to_dot_codex(monkeypatch):
    monkeypatch.delenv("CODEX_HOME", raising=False)
    assert auth_mod.codex_home() == Path.home() / ".codex"


def test_codex_home_respects_env_var(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "custom"))
    assert auth_mod.codex_home() == tmp_path / "custom"


def test_codex_home_empty_env_var_falls_back_to_default(monkeypatch):
    # Python: os.environ.get("CODEX_HOME") or (Path.home() / ".codex")
    # An empty string is falsy, so it falls back to the default.
    monkeypatch.setenv("CODEX_HOME", "")
    assert auth_mod.codex_home() == Path.home() / ".codex"


def test_auth_path_is_codex_home_slash_auth_json(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    assert auth_mod.auth_path() == tmp_path / "auth.json"


# -------------------------------------------------------------------- jwt


@pytest.mark.parametrize("case", load_fixture("jwt_exp"), ids=lambda c: c["label"])
def test_jwt_exp_matches_fixture(case):
    result = auth_mod._jwt_exp(case["token"])
    assert result == case["exp"]


def test_jwt_exp_swallows_arbitrary_exceptions():
    # None is not a valid input type (token.split will raise AttributeError);
    # Python's `except Exception` is broad enough to swallow it too.
    assert auth_mod._jwt_exp(None) is None  # type: ignore[arg-type]


# ------------------------------------------------------------------- load


def test_load_raises_when_file_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    with pytest.raises(RuntimeError) as ei:
        auth_mod.ChatGPTAuth.load()
    msg = str(ei.value)
    assert "No Codex credentials at" in msg
    assert "codex login" in msg
    assert str(tmp_path / "auth.json") in msg


def test_load_raises_when_no_access_token(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"tokens": {"refresh_token": "RT"}}), encoding="utf-8")
    with pytest.raises(RuntimeError) as ei:
        auth_mod.ChatGPTAuth.load()
    msg = str(ei.value)
    assert "has no ChatGPT access_token" in msg
    assert "Sign in with ChatGPT" in msg


def test_load_raises_when_tokens_missing_entirely(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"OPENAI_API_KEY": "sk-x"}), encoding="utf-8")
    with pytest.raises(RuntimeError, match="has no ChatGPT access_token"):
        auth_mod.ChatGPTAuth.load()


def test_load_raises_when_tokens_is_null(monkeypatch, tmp_path):
    # `raw.get("tokens") or {}` -- explicit null tokens must not blow up.
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"tokens": None}), encoding="utf-8")
    with pytest.raises(RuntimeError, match="has no ChatGPT access_token"):
        auth_mod.ChatGPTAuth.load()


def test_load_succeeds_and_populates_all_fields(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    p = tmp_path / "auth.json"
    p.write_text(
        json.dumps(
            {
                "tokens": {
                    "access_token": "AT",
                    "refresh_token": "RT",
                    "account_id": "ACC",
                    "id_token": "IT",
                },
                "last_refresh": "2026-01-01T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )
    a = auth_mod.ChatGPTAuth.load()
    assert a.access_token == "AT"
    assert a.refresh_token == "RT"
    assert a.account_id == "ACC"
    assert a.id_token == "IT"


def test_load_tolerates_missing_optional_fields(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"tokens": {"access_token": "AT"}}), encoding="utf-8")
    a = auth_mod.ChatGPTAuth.load()
    assert a.access_token == "AT"
    assert a.refresh_token is None
    assert a.account_id is None
    assert a.id_token is None


# ------------------------------------------------------------------- save


def test_save_creates_file_when_absent(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    a = auth_mod.ChatGPTAuth(access_token="AT", refresh_token="RT", account_id="ACC", id_token="IT")
    a.save()
    p = tmp_path / "auth.json"
    assert p.exists()
    raw = json.loads(p.read_text(encoding="utf-8"))
    assert raw["tokens"] == {
        "access_token": "AT",
        "refresh_token": "RT",
        "account_id": "ACC",
        "id_token": "IT",
    }
    assert "last_refresh" in raw


def test_save_merges_and_preserves_unknown_top_level_keys(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    p = tmp_path / "auth.json"
    p.write_text(
        json.dumps({"OPENAI_API_KEY": "sk-preserve-me", "some_unknown_key": {"nested": 1}}),
        encoding="utf-8",
    )
    a = auth_mod.ChatGPTAuth(access_token="AT2", refresh_token="RT2", account_id=None, id_token=None)
    a.save()
    raw = json.loads(p.read_text(encoding="utf-8"))
    assert raw["OPENAI_API_KEY"] == "sk-preserve-me"
    assert raw["some_unknown_key"] == {"nested": 1}
    assert raw["tokens"]["access_token"] == "AT2"


def test_save_overwrites_only_known_token_fields(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    p = tmp_path / "auth.json"
    p.write_text(
        json.dumps({"tokens": {"access_token": "OLD", "extra_field": "keep-me"}}),
        encoding="utf-8",
    )
    a = auth_mod.ChatGPTAuth(access_token="NEW", refresh_token=None, account_id=None, id_token=None)
    a.save()
    raw = json.loads(p.read_text(encoding="utf-8"))
    assert raw["tokens"]["access_token"] == "NEW"
    # dict.update merges rather than replaces the tokens sub-object.
    assert raw["tokens"]["extra_field"] == "keep-me"


def test_save_stamps_last_refresh_utc_format(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    a = auth_mod.ChatGPTAuth(access_token="AT", refresh_token=None, account_id=None)
    before = time.gmtime()
    a.save()
    raw = json.loads((tmp_path / "auth.json").read_text(encoding="utf-8"))
    # Format: %Y-%m-%dT%H:%M:%SZ
    stamp = raw["last_refresh"]
    assert stamp.endswith("Z")
    parsed = time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ")
    # sanity: within a couple seconds of "before"
    assert abs(time.mktime(parsed) - time.mktime(before)) < 5


def test_save_writes_indent_2(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    a = auth_mod.ChatGPTAuth(access_token="AT", refresh_token=None, account_id=None)
    a.save()
    text = (tmp_path / "auth.json").read_text(encoding="utf-8")
    assert '{\n  "' in text  # indent=2 formatting present


# ----------------------------------------------------------------- expired


def test_expired_matches_fixture_with_pinned_clock(monkeypatch):
    fixture = load_fixture("auth_expired")
    now = fixture["now"]
    monkeypatch.setattr(auth_mod.time, "time", lambda: now)

    def mk_jwt(payload):
        import base64

        raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
        return f"header.{raw}.sig"

    tokens_by_label = {
        "expires-far-future": mk_jwt({"exp": now + 3600}),
        "expires-in-90s": mk_jwt({"exp": now + 90}),
        "expires-in-30s-inside-skew": mk_jwt({"exp": now + 30}),
        "expires-exactly-60s": mk_jwt({"exp": now + 60}),
        "already-expired": mk_jwt({"exp": now - 10}),
        "unparseable-token": "nope",
    }

    for case in fixture["cases"]:
        token = tokens_by_label[case["label"]]
        a = auth_mod.ChatGPTAuth(token, None, None)
        assert a.expired == case["expired"], case["label"]


def test_expired_false_when_token_unparseable_even_though_clock_far_future(monkeypatch):
    # Confirms the `exp is not None and ...` short-circuit: an unparseable
    # token is never "expired" by this property, regardless of the clock.
    monkeypatch.setattr(auth_mod.time, "time", lambda: 9_999_999_999.0)
    a = auth_mod.ChatGPTAuth("garbage", None, None)
    assert a.expired is False


# ------------------------------------------------------------------ refresh


class _FakeResponse:
    def __init__(self, json_body, status_code=200):
        self._json = json_body
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=self)  # type: ignore[arg-type]

    def json(self):
        return self._json


def test_refresh_raises_without_refresh_token(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    a = auth_mod.ChatGPTAuth(access_token="AT", refresh_token=None, account_id=None)
    with pytest.raises(RuntimeError, match="run `codex login`"):
        a.refresh()


def test_refresh_posts_correct_body_and_updates_fields(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    captured = {}

    def fake_post(url, json=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["timeout"] = timeout
        return _FakeResponse({"access_token": "NEWAT", "refresh_token": "NEWRT", "id_token": "NEWIT"})

    monkeypatch.setattr(auth_mod.httpx, "post", fake_post)

    a = auth_mod.ChatGPTAuth(access_token="OLDAT", refresh_token="OLDRT", account_id="ACC", id_token="OLDIT")
    result = a.refresh()

    assert captured["url"] == auth_mod.TOKEN_URL
    assert captured["json"] == {
        "client_id": auth_mod.CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": "OLDRT",
        "scope": "openid profile email",
    }
    assert captured["timeout"] == 30

    assert result is a  # refresh() mutates and returns self
    assert a.access_token == "NEWAT"
    assert a.refresh_token == "NEWRT"
    assert a.id_token == "NEWIT"

    # save() was called as a side effect
    raw = json_module_load(tmp_path / "auth.json")
    assert raw["tokens"]["access_token"] == "NEWAT"


def json_module_load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_refresh_falls_back_to_existing_refresh_token_and_id_token_when_absent(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    def fake_post(url, json=None, timeout=None):
        # response body omits refresh_token and id_token entirely
        return _FakeResponse({"access_token": "NEWAT"})

    monkeypatch.setattr(auth_mod.httpx, "post", fake_post)

    a = auth_mod.ChatGPTAuth(access_token="OLDAT", refresh_token="OLDRT", account_id="ACC", id_token="OLDIT")
    a.refresh()

    assert a.access_token == "NEWAT"
    assert a.refresh_token == "OLDRT"  # unchanged: body.get("refresh_token", self.refresh_token)
    assert a.id_token == "OLDIT"  # unchanged


def test_refresh_raises_on_http_error_status(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))

    def fake_post(url, json=None, timeout=None):
        return _FakeResponse({"error": "invalid_grant"}, status_code=400)

    monkeypatch.setattr(auth_mod.httpx, "post", fake_post)

    a = auth_mod.ChatGPTAuth(access_token="AT", refresh_token="RT", account_id=None)
    with pytest.raises(httpx.HTTPStatusError):
        a.refresh()


# -------------------------------------------------------------- ensure_fresh


def test_ensure_fresh_returns_self_when_not_expired(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    monkeypatch.setattr(auth_mod.time, "time", lambda: 1_700_000_000.0)

    import base64

    def mk_jwt(payload):
        raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
        return f"header.{raw}.sig"

    token = mk_jwt({"exp": 1_700_000_000.0 + 3600})
    a = auth_mod.ChatGPTAuth(access_token=token, refresh_token="RT", account_id=None)

    called = {"refresh": False}
    monkeypatch.setattr(auth_mod.ChatGPTAuth, "refresh", lambda self: called.__setitem__("refresh", True) or self)

    result = a.ensure_fresh()
    assert result is a
    assert called["refresh"] is False


def test_ensure_fresh_calls_refresh_when_expired(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    monkeypatch.setattr(auth_mod.time, "time", lambda: 1_700_000_000.0)

    a = auth_mod.ChatGPTAuth(access_token="unparseable-but-not-expired", refresh_token="RT", account_id=None)
    # unparseable token -> expired is False -> ensure_fresh should NOT refresh
    called = {"refresh": False}
    monkeypatch.setattr(auth_mod.ChatGPTAuth, "refresh", lambda self: called.__setitem__("refresh", True) or self)
    a.ensure_fresh()
    assert called["refresh"] is False

    import base64

    def mk_jwt(payload):
        raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
        return f"header.{raw}.sig"

    expired_token = mk_jwt({"exp": 1_700_000_000.0 - 10})
    a2 = auth_mod.ChatGPTAuth(access_token=expired_token, refresh_token="RT", account_id=None)
    called2 = {"refresh": False}
    monkeypatch.setattr(auth_mod.ChatGPTAuth, "refresh", lambda self: called2.__setitem__("refresh", True) or self)
    a2.ensure_fresh()
    assert called2["refresh"] is True


# -------------------------------------------------------------------- headers


@pytest.mark.parametrize("case", load_fixture("auth_headers"), ids=lambda c: c["label"])
def test_headers_matches_fixture(case):
    a = auth_mod.ChatGPTAuth(**case["input"])
    assert a.headers() == case["headers"]


def test_headers_omits_account_id_key_entirely_when_empty_string():
    a = auth_mod.ChatGPTAuth(access_token="AT", refresh_token=None, account_id="")
    h = a.headers()
    assert "ChatGPT-Account-Id" not in h


# ---------------------------------------------------------------- base_url


def test_chatgpt_base_url_default(monkeypatch):
    monkeypatch.delenv("CODEX_CHATGPT_BASE_URL", raising=False)
    fixture = load_fixture("base_url")
    assert auth_mod.chatgpt_base_url() == fixture["default"]


@pytest.mark.parametrize("case", load_fixture("base_url")["rstrip_cases"], ids=lambda c: c["env"])
def test_chatgpt_base_url_rstrips_all_trailing_slashes(monkeypatch, case):
    monkeypatch.setenv("CODEX_CHATGPT_BASE_URL", case["env"])
    assert auth_mod.chatgpt_base_url() == case["expect"]


def test_constants_match_fixture():
    fixture = load_fixture("base_url")
    assert auth_mod.DEFAULT_CHATGPT_BASE_URL == fixture["default"]
    assert auth_mod.TOKEN_URL == fixture["token_url"]
    assert auth_mod.CLIENT_ID == fixture["client_id"]
