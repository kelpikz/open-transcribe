# codex-audio

Standalone speech-to-text using the ChatGPT subscription credentials from
`codex login`.

```bash
bun run start                      # speak, press Enter, print the transcript
bun run start meeting.wav          # transcribe an audio file
bun run start --json meeting.wav
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
in `ts/src/codex/realtime.ts` as legacy reference code.

## Install

You need [Bun](https://bun.sh) and `ffmpeg` on the PATH. ffmpeg does the
microphone capture.

```bash
cd ts
bun install
codex login                 # choose Sign in with ChatGPT
bun run start
```

To get a single executable instead:

```bash
bun run build               # writes dist/codex-audio
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

Set `CODEX_AUDIO_ASCII=1` if your console font cannot show the `…`, `✓` and `─`
glyphs.

## Files

- `ts/src/cli.ts` — argument parsing and entry point
- `ts/src/renderer.ts` — terminal output for the transcript stages
- `ts/src/audio/index.ts` — the audio surface: capture, processing, devices
- `ts/src/audio/capture.ts` — microphone and file sources
- `ts/src/audio/processing.ts` — ffmpeg, WAV encoding, RTP tracks
- `ts/src/audio/devices.ts` — input device names and listing
- `ts/src/codex/index.ts` — the Codex surface: auth, transcribe, realtime
- `ts/src/codex/auth.ts` — reads and refreshes the Codex login credentials
- `ts/src/codex/transcribe.ts` — multipart upload and response handling
- `ts/src/codex/realtime.ts` — legacy WebRTC implementation, no longer used

This relies on an internal Codex Desktop route, so it may change without notice.
