# codex-audio

Standalone speech-to-text using the ChatGPT subscription credentials from
`codex login`.

```bash
bun run start                      # speak, press Enter, print the transcript
bun run start meeting.wav          # transcribe an audio file
bun run start --json meeting.wav
bun run start --stream             # show the text while you speak
bun run start --listen             # Windows: hold Ctrl+Shift+Space to dictate anywhere
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
| `--listen` | Windows: hold the hotkey to dictate into the focused window |
| `--hotkey KEYS` | The `--listen` hotkey (default `ctrl+shift+space`) |

These options change only `--stream`: `--model`, `--prompt`, `--silence-ms`,
`--noise-reduction`, `--no-partials`, `--raw-events`, `--session` (a JSON file
that replaces the session payload) and `--drain` (seconds to wait for the last
transcripts, default 10).

Set `CODEX_AUDIO_ASCII=1` if your console font cannot show the `…`, `✓` and `─`
glyphs.

## Dictation in any app (Windows)

```bash
bun run start --listen                      # hold Ctrl+Shift+Space, speak, release
bun run start --listen --hotkey ctrl+win
```

`--listen` stays in the background until you press Ctrl+C in its console.

1. Hold the hotkey and speak. Release the hotkey to stop.
2. The clip goes to the upload route, the most accurate route.
3. If a window is in front, the text is pasted into it with Ctrl+V. Then the
   old clipboard content is put back. Clipboard history (Win+V) does not keep
   the pasted text.
4. If the desktop or the taskbar is in front, or focus moves to another
   window, the text is copied to the clipboard only, and a short notice shows.
   The app waits up to three seconds for the hotkey and all modifier keys to
   be released. If any remain held or are pressed again before paste, it copies instead.

Points to know:

- The microphone stays open while `--listen` runs, and Windows shows the
  microphone icon. This is necessary: a microphone takes about 0.6 s to open,
  so your first words would be lost if it opened on each key press. Audio is
  kept only while you hold the hotkey, plus the last 0.3 s before it.
- A hold shorter than 0.3 s, or a clip with no sound, is not sent.
- A hotkey is a list of keys joined with `+`: `ctrl`, `shift`, `alt`, `win`,
  their left and right forms (`lctrl`, `rwin`, ...), `space`, `tab`,
  `capslock`, `insert`, `pause`, `scrolllock`, `a`–`z`, `0`–`9`, `f1`–`f24`.
- With a `win` hotkey, codex-audio sends an unused key (`vkE8`) when the hotkey
  goes down, so the Start menu does not open when you release it.
- An app that runs as administrator does not accept a paste from a normal
  process. Run codex-audio as administrator for those apps.

## Desktop app (Windows)

The desktop app does the same dictation as `--listen`, with a window and a tray
icon. It uses Tauri. The Bun code runs as a sidecar process.

```bash
cd app
bun install
bun run dev      # build the sidecar, then start the app
bun run build    # build the sidecar, then make the installer
```

You need Rust (for Tauri) and ffmpeg on `PATH`.

- Hold the shortcut and speak. Release it to insert the text.
- The microphone is open only while you hold the shortcut. It takes about
  0.6 s to open. The dot in the pill is grey until then. Speak when it turns
  red.
- A pill at the bottom of the screen shows a live waveform and a timer while
  you record. The pill does not take focus and does not catch clicks, so the
  text goes to the window you work in.
- If recording, transcription, or insertion fails, the pill shows a short
  error for six seconds. Starting another recording replaces it immediately.
  For details, open settings. If insertion failed, use **Copy it again**.
- The window is one settings page. The top shows how to dictate. If
  something is wrong (signed out, no ffmpeg, no microphone), it shows the
  problem and the fix.
- You can change the shortcut, the language, the microphone, what happens
  after you speak (paste, or copy only), start with Windows, and sounds.
- The text is not saved. Only the last text is kept in memory, for
  **Copy it again**.
- Closing the window hides it. Use the tray icon to open it again or to quit.
- Opening the app again shows the existing settings window. Only one copy runs.
- Settings are in `%APPDATA%\com.kelpikz.codex-audio\settings.json`.

## Files

- `ts/src/cli.ts` — argument parsing and entry point
- `ts/src/renderer.ts` — terminal output for the transcript stages
- `ts/src/audio/index.ts` — the audio surface: capture, processing, devices
- `ts/src/audio/capture.ts` — microphone and file sources, and the always-open microphone for `--listen`
- `ts/src/audio/processing.ts` — ffmpeg, WAV encoding, RTP tracks
- `ts/src/audio/devices.ts` — input device names and listing
- `ts/src/codex/index.ts` — the Codex surface: auth, transcribe, realtime
- `ts/src/codex/auth.ts` — reads and refreshes the Codex login credentials
- `ts/src/codex/transcribe.ts` — multipart upload and response handling
- `ts/src/codex/realtime.ts` — WebRTC client for `--stream`
- `ts/src/listen.ts` — `--listen`: hotkey, clip handling, paste or copy
- `ts/src/desktop/win32.ts` — Windows calls: key state, keys, foreground window, clipboard, notice, sound
- `ts/src/sidecar.ts` — the desktop app's background process: hold-to-talk shortcut, settings, microphone
- `app/src-tauri/src/main.rs` — Tauri shell: starts the sidecar, pill window, tray icon
- `app/ui/` — the settings window and the recording pill

This relies on an internal Codex Desktop route, so it may change without notice.
