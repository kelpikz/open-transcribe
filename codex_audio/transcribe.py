"""Speech-to-text through the upload route used by Codex Desktop."""

from __future__ import annotations

import mimetypes
from pathlib import Path

import httpx

from .auth import ChatGPTAuth, chatgpt_base_url

TRANSCRIBE_URL_SUFFIX = "/transcribe"
DEFAULT_LANGUAGE = "en"
# Kept for CLI compatibility; the desktop upload route selects its service model.
DEFAULT_MODEL = "gpt-4o-transcribe"
TRANSCRIBE_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]


class TranscriptionError(RuntimeError):
    """The ChatGPT transcription service rejected or malformed a request."""


def content_type_for(path: str | Path) -> str:
    """Return an audio MIME type suitable for the multipart upload."""
    suffix = Path(path).suffix.lower()
    known = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".webm": "audio/webm",
        ".weba": "audio/webm",
        ".ogg": "audio/ogg",
        ".oga": "audio/ogg",
        ".flac": "audio/flac",
        ".aac": "audio/aac",
    }
    if suffix in known:
        return known[suffix]
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed if guessed and guessed.startswith("audio/") else "application/octet-stream"


def transcribe_audio(
    data: bytes,
    *,
    filename: str,
    content_type: str,
    language: str | None = "en",
) -> str:
    """Upload one complete recording and return its transcript."""
    auth = ChatGPTAuth.load().ensure_fresh()
    url = f"{chatgpt_base_url()}{TRANSCRIBE_URL_SUFFIX}"
    form = {} if not language or language == "auto" else {"language": language}

    response = httpx.post(
        url,
        headers=auth.transcription_headers(),
        files={"file": (filename, data, content_type)},
        data=form,
        timeout=120,
    )
    if response.status_code != 200:
        raise TranscriptionError(f"{response.status_code} from {url}: {response.text[:500]}")

    try:
        body = response.json()
        text = body["text"]
    except (ValueError, KeyError, TypeError) as exc:
        raise TranscriptionError("transcription response did not contain a text field") from exc
    if not isinstance(text, str):
        raise TranscriptionError("transcription response text was not a string")
    return text


def transcribe_file(path: str, *, language: str | None = "en") -> str:
    """Read and transcribe an audio file."""
    file_path = Path(path)
    return transcribe_audio(
        file_path.read_bytes(),
        filename=file_path.name,
        content_type=content_type_for(file_path),
        language=language,
    )
