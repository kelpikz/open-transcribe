# codex-audio

Standalone speech-to-text using the ChatGPT subscription credentials from
`codex login`.

```bash
uv run codex-audio                 # speak, press Enter, print the transcript
uv run codex-audio meeting.wav     # transcribe an audio file
uv run codex-audio --json meeting.wav
```

## How it works

The microphone button in the Codex Desktop composer is **batch dictation**, not
the experimental realtime-conversation/WebRTC feature. The desktop app uploads
the completed recording here:

```http
POST https://chatgpt.com/backend-api/transcribe
Authorization: Bearer <token from ~/.codex/auth.json>
ChatGPT-Account-Id: <account id>
Content-Type: multipart/form-data

file=<audio recording>
language=en
```

`codex-audio` follows that route and uses the same ChatGPT OAuth credentials.
It does not require an OpenAI API key. The old WebRTC route,
`/backend-api/codex/realtime/calls`, currently returns 404 and is retained only
in `codex_audio/realtime.py` as legacy reference code.

## Install

```bash
uv sync
codex login                 # choose Sign in with ChatGPT
uv run codex-audio
```

## Usage

| Option | Effect |
|---|---|
| *(no input)* | Record from the default microphone until Enter is pressed |
| `<file>` | Upload and transcribe an audio file |
| `--device N` | Select a microphone (`--list-devices` lists devices) |
| `--language`, `-l` | Send an ISO-639-1 language hint; `auto` omits it |
| `--json` | Emit `{"text": "..."}` |
| `--quiet`, `-q` | Suppress progress output on stderr |

`--stream` is not available because the desktop upload route returns one final
transcript. The former realtime-only options remain accepted as compatibility
options but do not change upload transcription.

## Files

- `codex_audio/auth.py` — reads and refreshes the Codex login credentials
- `codex_audio/transcribe.py` — multipart upload and response handling
- `codex_audio/audio.py` — microphone capture and WAV encoding
- `codex_audio/realtime.py` — legacy WebRTC implementation, no longer used

This relies on an internal Codex Desktop route, so it may change without notice.
