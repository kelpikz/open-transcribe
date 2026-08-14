# Implementation notes

Edge cases, hacks, and non-obvious decisions. Short entries only.

## Endpoints

- `POST /backend-api/codex/realtime/calls` → **404** (2026-08-14). Not auth: `/me`,
  `/accounts/check`, `/models` all returned 200 with the same token. 9 path
  variants probed, all 404.
- `POST /backend-api/transcribe` (upload route) is **unverified** — the one
  attempt failed earlier, at auth load, because `~/.codex/auth.json` lost its
  access token mid-session. Treat as reported, not proven.
- Binary strings from codex-cli 0.147.0 show `realtime_websocket/protocol_v2.rs`
  with fields `transcript`, `delta`, `sample_rate`, `channels`,
  `samples_per_channel`, `data` → suggests raw PCM over WebSocket, not Opus over
  WebRTC. Unconfirmed. If true, fixing realtime means *deleting* the WebRTC
  stack, not repairing it.

## Testing strategy

- No live service, so the Python is the oracle: `tools/gen_fixtures.py` records
  its exact pure-logic output to `fixtures/*.json`. TS asserts against the same
  files. This survives deleting the Python.
- After the pivot to the upload route, all 11 original fixtures regenerated
  **byte-identical** — the pivot was purely additive.

## auth

- `_jwt_exp` uses Python `float()`, whose grammar is *not* JS `Number()`:
  accepts `"1_000"`, `"inf"`, `"-inf"`, `"nan"`, surrounding whitespace;
  rejects leading/trailing/adjacent underscores. Ported as a hand-written
  `pyFloat` grammar, not `parseFloat`.
- Python falsiness ≠ JS falsiness: `[]` and `{}` are falsy in Python. `load()`'s
  access-token check and the header filters depend on this — needed a `pyTruthy`
  helper.
- `refresh()` must throw *before* mutating any field if `access_token` is
  missing, or the token silently vanishes from the persisted file.
- `save()` merges into the existing file, preserves unknown top-level keys,
  `indent=2`, and stamps `last_refresh` as UTC `%Y-%m-%dT%H:%M:%SZ`. It must
  leave the file untouched when the existing shape is malformed.
- Expiry uses a 60s early-refresh skew, and is `false` when the token is
  unparseable (`exp is not None and exp - 60 < now`). Clock is injectable so
  this is testable.
- `chatgpt_base_url()` strips **all** trailing slashes (`rstrip("/")`), not one.

## transcribe (upload route)

- Language rule is `if not language or language == "auto"` → `null`, `""` and
  `"auto"` all send **no** form field.
- Extension lookup is case-insensitive (`Path.suffix.lower()`). Unknown
  extensions fall back to a MIME guess; anything not `audio/*` becomes
  `application/octet-stream`. `mimetypes.guess_type` is registry-dependent on
  Windows, so the fixture pins what this machine produced.
- `transcription_headers()` sets `ChatGPT-Account-Id` to `account_id or ""`,
  then drops empty values — so a missing account id yields no header at all
  rather than an empty one.

## audio

- Two unrelated sample rates in one module: **24000 Hz / blocksize 2400** for
  `record_microphone` (upload route), **48000 Hz / 960 samples** for the legacy
  WebRTC constants. Do not conflate.
- werift's `MediaStreamTrack.writeRtp()` takes **RTP packets, not PCM**. aiortc
  did Opus encode + packetization internally; werift does neither. Biggest
  structural divergence in the port. Route: ffmpeg `-f rtp` → UDP → `node:dgram`
  → `writeRtp`, which also gives realtime pacing for free (a file must play at
  wall-clock speed, not be blasted at the server).
- Mic queue is bounded at 50 and drops the **oldest** frame when full — stale
  audio is worthless for dictation. Never let it grow unbounded.
- Python stashes `player.audio._player_ref = player` purely to defeat GC. TS
  equivalent: don't let the ffmpeg process die while the track is live.

## cli

- `Renderer` sniffs `sys.stderr.encoding` and falls back from `… ✓ ─` to
  `... * -` when it can't encode them (Windows cp1252). The dev console really
  is cp1252 — printing `✓` there throws.
- Live line is truncated to the last 110 chars so it overwrites cleanly on one
  terminal row.
- Parsed arg keys are argparse's **snake_case** (`silence_ms`, `no_partials`,
  `raw_events`) — kept in TS so `ParsedArgs` compares directly against fixtures.
- `--device` stays a *string* through parsing; `main()` converts all-digit
  values to a number afterwards.
- `--stream` now exits **2** with a message; the upload route returns one final
  transcript.

## werift / Bun

- werift works under Bun: complete non-trickle offer, Opus audio m-line, data
  channel, `iceGatheringState: "complete"` after `setLocalDescription` — same
  assumption aiortc's code makes. Pure TS, so `bun build --compile` stays viable.
- Divergence: werift gathers `srflx` candidates via a default STUN server;
  aiortc gathers host candidates only. Noted, not chased.

## Process / environment gotchas

- **Worktree agents branch from committed state and cannot see a dirty tree.**
  Uncommitted Python changes caused the first wave to port code that had already
  moved. Snapshot before spawning.
- Git Bash on Windows can leave a literal `NUL` file in the repo (reserved device
  name); `git add` then fails with "short read while indexing NUL". Delete it.
- `.gitignore` needs `.tmp_codex-src` **without** a trailing slash — an embedded
  git repo is a gitlink entry, and the directory pattern doesn't match it.
- The venv is uv-managed and has no `pip`; use `uv pip install`.
