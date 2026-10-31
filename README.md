# codex-audio

Standalone speech-to-text using the ChatGPT subscription credentials from
`codex login`.

```bash
bun run start                      # speak, press Enter, print the transcript
bun run start meeting.wav          # transcribe an audio file
bun run start --json meeting.wav
bun run start --stream             # show the text while you speak
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
It does not require an OpenAI API key.

`--stream` uses a second route, `/backend-api/codex/realtime/calls`. It sends
the audio over WebRTC, and server VAD sends back one transcript for each
segment of speech. This route returned 404 for a period. It worked again on
2026-10-31.

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
| `--stream` | Stream over WebRTC and show each segment when you pause |

These options change only `--stream`: `--model`, `--prompt`, `--silence-ms`,
`--noise-reduction`, `--no-partials`, `--raw-events`, `--session` (a JSON file
that replaces the session payload) and `--drain` (seconds to wait for the last
transcripts, default 10).

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
- `ts/src/codex/realtime.ts` — WebRTC client for `--stream`

This relies on an internal Codex Desktop route, so it may change without notice.
