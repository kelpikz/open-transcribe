# codex-audio

Standalone speech-to-text that runs on your **ChatGPT subscription** — no API key, no local Whisper, no extra billing. It reuses the same endpoint and the same credentials as the microphone button in the Codex app.

```bash
codex-audio                    # talk, press Enter, get text on stdout
codex-audio meeting.mp3        # transcribe a file
codex-audio --json | jq -r .text
```

Requires a `codex login` session (ChatGPT sign-in, not API key). Nothing else to configure.

## How it works

Reverse-engineered from `@openai/codex` 0.146.0 (a compiled Rust binary) and confirmed against the live service. Codex routes voice through `chatgpt.com/backend-api`, **not** `api.openai.com` — which is exactly why it bills the ChatGPT plan rather than a platform API key.

### The call

```http
POST https://chatgpt.com/backend-api/codex/realtime/calls
Authorization: Bearer <access_token from ~/.codex/auth.json>
ChatGPT-Account-Id: <account_id>
Content-Type: application/json

{"sdp": "<webrtc offer>", "session": {"type": "transcription", ...}}
```

Responds `201` with a raw SDP answer. Audio then flows over WebRTC (Opus); transcripts come back as JSON on the `oai-events` data channel.

### The session payload

```json
{
  "type": "transcription",
  "audio": {
    "input": {
      "format":         {"type": "audio/pcm", "rate": 24000},
      "noise_reduction": null,
      "turn_detection":  null,
      "transcription":  {"model": "gpt-4o-transcribe", "language": "en"}
    }
  }
}
```

This mirrors what Codex sends, with one addition: Codex omits `language`, and uses `gpt-4o-mini-transcribe` where this defaults to the stronger `gpt-4o-transcribe`.

What each key does:

| Key | Effect |
|---|---|
| `type: "transcription"` | Dictation session — listen and transcribe, never reply. The alternative, `"quicksilver"`, is the conversational voice mode. |
| `format` | How to interpret the decoded audio: 24kHz mono PCM. WebRTC carries Opus; this describes what the server decodes it to. |
| `noise_reduction` | `near_field` for a laptop/headset mic held close; `far_field` for a room mic. Wrong choice = filtering tuned for the wrong noise profile. |
| `turn_detection` | Where to cut the audio into segments. `server_vad` cuts on silence; `null` never cuts, and you commit manually. |
| `transcription.model` | Which model transcribes each segment. |
| `transcription.language` | ISO-639-1 hint. Without it the language is re-guessed per segment. |
| `transcription.prompt` | Free-text context to bias spelling of names and jargon. |

`transcription` is load-bearing. Omit it and the service still connects, runs VAD, and commits conversation items — but every transcript field comes back `null`. That one key is the difference between a working dictation tool and a silent one.

Verified models: `gpt-4o-transcribe` (default), `gpt-4o-mini-transcribe`, `whisper-1`.

### Why segmentation drives accuracy

**Each segment is transcribed independently, with no knowledge of its neighbours.** So segmentation *is* the accuracy setting — and Codex's answer is to not segment at all.

Per `session_update_session` in `realtime_conversation.rs`, transcription mode sends `turn_detection: None`, `noise_reduction: None`, `instructions: None`, `output_modalities: None`, and `model: "gpt-4o-mini-transcribe"`. No VAD: audio accumulates and is committed once, so the model transcribes the whole utterance with full context. `server_vad` with `silence_duration_ms: 500` belongs to the *conversational* path, not this one.

This tool defaults to the same shape. `--stream` opts into VAD segmentation for live partials, trading accuracy for feedback: a three-word fragment carries almost no context, gets mis-heard, and can even be assigned a different language.

The final text is a *concatenation* of settled segments, never a second pass — nothing revisits an earlier segment. That is exactly why whole-utterance wins.

One subtlety in `--stream`: when audio stops, the server never observes the trailing silence that would close the last segment, so it would be stranded. The tool always commits the buffer at the end to recover it.

### What the binary gave up

Endpoint paths, protocol event names, and audio parameters were recovered from string and serde-metadata extraction:

| Finding | Source |
|---|---|
| `experimental_realtime_ws_mode = "transcription" \| "conversational"` | `ConfigToml` serde blob |
| `codex-api/src/endpoint/realtime_call.rs`, `.../realtime_websocket/methods.rs` | embedded panic paths |
| `audio/pcm`, `server_vad`, `near_field`, `input_audio_buffer.append` | protocol enum blob |
| `conversation.item.input_audio_transcription.delta`/`.completed` | realtime v1 event names |
| `ChatGPT-Account-Id`, `openai-alpha: quicksilver=v1\|v2` | header table |

The base URL was *not* recoverable statically (it's a code default, not a string literal), so it was resolved by probing: `404` on wrong paths → `400 Unsupported content type` on the right one → the server's own validators named the remaining fields. Auth was never the obstacle — no probe ever returned `401`.

### Two lanes, one door

`/codex/realtime/calls` serves two different session types:

- **`type: "transcription"`** — plain JSON body, no extra headers. Dictation. This is what this tool uses.
- **`type: "quicksilver"`** — requires `?intent=quicksilver&architecture=avas` plus an `openai-alpha` header. This is conversational voice mode (Codex's "AVAS" path); it answers `Voice session access denied` unless your account is entitled to it.

## Install

```bash
uv sync && uv run codex-audio
```

Or run without installing:

```bash
uv run --with aiortc --with sounddevice --with httpx python -m codex_audio.cli
```

## Usage

| Flag | Effect |
|---|---|
| *(no args)* | record from the default mic until you press Enter |
| `<file>` | transcribe any file ffmpeg can decode |
| `--device N` | pick an input device (`--list-devices` to see them) |
| `--model M` | choose the transcription model |
| `--stream` | segment while speaking for live partials — less accurate (see below) |
| `--silence-ms N` | `--stream` only: pause that ends a segment (default 500) |
| `--noise-reduction` | `near_field` (headset), `far_field` (room mic), or `none` (default) |
| `--language`, `-l` | ISO-639-1 hint, default `en`; `auto` to detect per segment |
| `--prompt` | context hint to bias spelling of names and jargon |
| `--json` | emit `{"text": "..."}` |
| `--quiet`, `-q` | no progress output on stderr |
| `--no-partials` | show only settled segments, not live guesses |
| `--no-color` | disable ANSI colour |
| `--raw-events` | dump every protocol event — useful when the API shifts |
| `--drain N` | seconds to keep listening after stop for in-flight audio (default 2) |

### The two transcript stages

Dictation produces output twice, and the tool keeps them visually distinct:

```
  … the quick brown fox jum        ← live guess, rewrites itself in place, discarded
  ✓ The quick brown fox jumps over the lazy dog.   ← settled segment, kept
  ✓ Testing codex audio transcription.
────────────────────────────────────────
The quick brown fox jumps over the lazy dog. Testing codex audio transcription.
```

Everything above the rule is **stderr** progress. Only the assembled line below it goes to **stdout**, so `codex-audio > notes.txt` captures exactly the final text and nothing else. Piped output drops the live line and the ANSI entirely.

### Language

Each VAD segment is transcribed independently. With no language hint the model re-guesses on every utterance, so a short or noisy segment can come back as Welsh or Malay even in an all-English session. The default `--language en` pins it. Pass `-l auto` for genuinely multilingual input, or `-l hi`, `-l es`, etc.

## Layout

- [`auth.py`](codex_audio/auth.py) — reads `~/.codex/auth.json`, auto-refreshes expiring tokens against `auth.openai.com/oauth/token`, mints Codex's header set
- [`realtime.py`](codex_audio/realtime.py) — SDP negotiation, session payload, event handling
- [`audio.py`](codex_audio/audio.py) — mic capture (sounddevice → WebRTC track) and file playback
- [`cli.py`](codex_audio/cli.py) — argument parsing and output

## Caveats

This is an **internal, unversioned endpoint**. It carries no API stability guarantee and can change or disappear without notice — `--raw-events` is there so you can see what shifted. Usage counts against your ChatGPT plan's limits.
