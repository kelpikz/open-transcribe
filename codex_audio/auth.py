"""ChatGPT subscription auth, reused from the Codex CLI's credential store.

Codex stores OAuth tokens in ~/.codex/auth.json:

    {
      "OPENAI_API_KEY": null,
      "tokens": {
        "id_token": "...",
        "access_token": "...",
        "refresh_token": "...",
        "account_id": "..."
      },
      "last_refresh": "2026-08-03T18:15:00Z"
    }

We read the same file and mint the same headers Codex sends, so requests are
billed against the ChatGPT plan rather than a platform API key.
"""

from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

TOKEN_URL = "https://auth.openai.com/oauth/token"
# Same client_id the Codex CLI registers for its device/PKCE login.
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api"


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))


def auth_path() -> Path:
    return codex_home() / "auth.json"


def _jwt_exp(token: str) -> float | None:
    """Read `exp` out of a JWT without verifying it (we only need the clock)."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return float(json.loads(base64.urlsafe_b64decode(payload))["exp"])
    except Exception:
        return None


@dataclass
class ChatGPTAuth:
    access_token: str
    refresh_token: str | None
    account_id: str | None
    id_token: str | None = None

    @classmethod
    def load(cls) -> "ChatGPTAuth":
        p = auth_path()
        if not p.exists():
            raise RuntimeError(
                f"No Codex credentials at {p}.\n"
                "Run `codex login` first — this tool reuses that session."
            )
        raw = json.loads(p.read_text(encoding="utf-8"))
        tokens = raw.get("tokens") or {}
        access = tokens.get("access_token")
        if not access:
            raise RuntimeError(
                f"{p} has no ChatGPT access_token (API-key-only login?).\n"
                "Run `codex login` and choose 'Sign in with ChatGPT'."
            )
        return cls(
            access_token=access,
            refresh_token=tokens.get("refresh_token"),
            account_id=tokens.get("account_id"),
            id_token=tokens.get("id_token"),
        )

    def save(self) -> None:
        p = auth_path()
        raw = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        raw.setdefault("tokens", {})
        raw["tokens"].update(
            {
                "access_token": self.access_token,
                "refresh_token": self.refresh_token,
                "account_id": self.account_id,
                "id_token": self.id_token,
            }
        )
        raw["last_refresh"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        p.write_text(json.dumps(raw, indent=2), encoding="utf-8")

    @property
    def expired(self) -> bool:
        exp = _jwt_exp(self.access_token)
        # Refresh a minute early rather than racing the boundary mid-session.
        return exp is not None and exp - 60 < time.time()

    def refresh(self) -> "ChatGPTAuth":
        if not self.refresh_token:
            raise RuntimeError("Access token expired and no refresh_token stored; run `codex login`.")
        r = httpx.post(
            TOKEN_URL,
            json={
                "client_id": CLIENT_ID,
                "grant_type": "refresh_token",
                "refresh_token": self.refresh_token,
                "scope": "openid profile email",
            },
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        self.access_token = body["access_token"]
        self.refresh_token = body.get("refresh_token", self.refresh_token)
        self.id_token = body.get("id_token", self.id_token)
        self.save()
        return self

    def ensure_fresh(self) -> "ChatGPTAuth":
        return self.refresh() if self.expired else self

    def headers(self) -> dict[str, str]:
        """The header set Codex attaches to ChatGPT-backed requests."""
        h = {
            "Authorization": f"Bearer {self.access_token}",
            "User-Agent": "codex-audio/0.1 (reverse-engineered from codex-cli)",
            "originator": "codex_cli_rs",
        }
        if self.account_id:
            h["ChatGPT-Account-Id"] = self.account_id
        return h

    def transcription_headers(self) -> dict[str, str]:
        """Headers used by Codex Desktop's `/transcribe` upload route.

        This route is separate from realtime conversation.  The desktop app
        identifies the upload as a Codex attachment and uses the desktop
        originator, while authentication still comes from the Codex login.
        """
        h = {
            "Authorization": f"Bearer {self.access_token}",
            "User-Agent": "codex-audio/0.1 (reverse-engineered from Codex Desktop)",
            "ChatGPT-Account-Id": self.account_id or "",
            "originator": "Codex Desktop",
            "x-codex-base64": "1",
            "X-OpenAI-Attach-Auth": "1",
            "X-OpenAI-Attach-Desktop-Surface": "Codex Desktop",
            "X-OpenAI-Attach-Integrity-State": "1",
        }
        return {key: value for key, value in h.items() if value}


def chatgpt_base_url() -> str:
    return os.environ.get("CODEX_CHATGPT_BASE_URL", DEFAULT_CHATGPT_BASE_URL).rstrip("/")
