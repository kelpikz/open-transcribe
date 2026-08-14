# Implementation notes

This file uses ASD-STE100 Simplified Technical English. Write short sentences.
Use the active voice. Use the simple present tense. Keep each entry short.

## Endpoints

- `POST /backend-api/codex/realtime/calls` gives code 404 (2026-08-14).
- This is not an authentication problem. The same token gets code 200 from
  `/me`, `/accounts/check`, and `/models`. We tried 9 different paths. All 9
  paths give code 404.
- `POST /backend-api/transcribe` is the upload route. Nobody has tested this
  route. The one test stopped at the authentication step, because
  `~/.codex/auth.json` lost its access token. Do not assume that this route
  operates correctly.
- The codex-cli 0.147.0 binary contains `realtime_websocket/protocol_v2.rs`.
  That module has the fields `transcript`, `delta`, `sample_rate`, `channels`,
  `samples_per_channel`, and `data`. These fields show raw PCM data on a
  WebSocket, and not Opus data on WebRTC. This is not confirmed. If it is
  correct, you must delete the WebRTC code. Do not repair it.

## Test strategy

- There is no live service. Thus the Python code is the reference.
  `tools/gen_fixtures.py` writes the exact Python output to `fixtures/*.json`.
  The TypeScript tests compare against the same files. These files stay
  correct after you delete the Python code.
- The Python code changed to the upload route. After this change, all 11 of
  the first fixtures are identical. The change only added code.
- A test for a resource leak must have a margin that is larger than the leak.
  One test did one operation and permitted one more socket. The error also
  made one more socket. Thus the test gave a pass result with the bad code.
  Do 5 operations at the same time. Then the signal is larger than the margin.

## auth

- `_jwt_exp` uses the Python `float()` function. The Python grammar is
  different from the JavaScript `Number()` grammar. Python accepts `"1_000"`,
  `"inf"`, `"-inf"`, `"nan"`, and spaces at each end. Python rejects an
  underscore at the start or the end. Use the `pyFloat` function. Do not use
  `parseFloat`.
- Python false values are different from JavaScript false values. In Python,
  `[]` and `{}` are false. The access token test in `load()` and the header
  filters use this rule. Use the `pyTruthy` function.
- `refresh()` must stop with an error before it changes a field, if
  `access_token` is not in the response. If it does not stop first, the token
  goes out of the file.
- `save()` adds data to the file that is present. It keeps the unknown keys at
  the top level. It uses `indent=2`. It writes `last_refresh` in the UTC
  format `%Y-%m-%dT%H:%M:%SZ`. If the data in the file has a bad shape,
  `save()` must not change the file.
- The token expiry test uses a 60 second margin. The result is false if the
  token is not readable. The rule is `exp is not None and exp - 60 < now`. You
  can supply the clock, thus you can test this function.
- `chatgpt_base_url()` removes all the slashes at the end. It does not remove
  only one slash.

## transcribe (upload route)

- The language rule is `if not language or language == "auto"`. Thus `null`,
  `""`, and `"auto"` send no `language` field.
- The file extension test ignores the letter case. It uses
  `Path.suffix.lower()`. For an unknown extension, the code makes a guess. If
  the guess is not `audio/*`, the code uses `application/octet-stream`.
- `mimetypes.guess_type` gives different results on different systems, because
  it reads the Windows registry. The fixture holds the results from this
  computer.
- `transcription_headers()` sets `ChatGPT-Account-Id` to `account_id or ""`.
  Then it removes the empty values. Thus, if there is no account id, the
  header is not present. The header is not empty.
- The Python function `transcribe_audio` has the default value `language="en"`
  in its signature. If you do not supply the `language` key, the function uses
  `"en"`. If you supply `None`, the function sends no field. These two
  conditions are different. Use a key presence test. Do not use a default
  value for a null result.
- `Path.suffix` removes all the dots at the start of the name. The Node
  function `path.extname` removes only one dot. Thus Python finds no suffix in
  `"..wav"`, but Node finds `.wav`. Use the `pySuffix` function.
- `response.text[:500]` counts Unicode code points. The JavaScript function
  `.slice(0, 500)` counts UTF-16 code units. Thus `.slice()` can divide a
  surrogate pair. Use the `codepointSlice` function.
- The MIME types for `.opus` and `.aiff` are constant values in the code. They
  come from the fixture. There is no correct method to do `mimetypes.
  guess_type` on all systems.
- The `fetch` function has no timeout option. Use
  `AbortSignal.timeout(120_000)` in place of the Python `timeout=120`.
- The auth port was complete before the Python code got
  `transcription_headers()`. Thus the transcribe agent added
  `transcriptionHeaders()` to `ts/src/auth.ts`.

## audio

- This module has two different sample rates. `record_microphone` uses 24000 Hz
  and a block size of 2400. The old WebRTC constants use 48000 Hz and 960
  samples. Do not use one value in place of the other.
- The werift function `MediaStreamTrack.writeRtp()` accepts RTP packets. It
  does not accept PCM data. The Python library aiortc does the Opus compression
  and the packet assembly. The werift library does neither of these two
  operations. This is the largest difference between the two languages.
- Use this method: ffmpeg with `-f rtp`, then UDP, then `node:dgram`, then
  `writeRtp`. This method also gives the correct speed. A file must play at
  real-time speed. Do not send a full file quickly.
- The microphone queue holds a maximum of 50 items. When the queue is full, it
  removes the oldest item. Old audio data is not useful for dictation. The
  queue must not increase without a limit.
- The Python code sets `player.audio._player_ref = player`. This keeps the
  player in memory. In TypeScript, the ffmpeg process must continue while the
  track is live.
- `Promise.race` does not stop the branch that loses. The caller must release
  the resources of that branch.
- The `readline` interface adds `data`, `end`, and `error` listeners to
  `process.stdin`. Only `rl.close()` removes these listeners. If ffmpeg stops
  first, the listeners stay for the life of the process. The count increased
  from 0 to 2 in 3 calls. A garbage collection does not remove them. Thus
  `waitForStdinLine()` returns a `cancel` function. `recordMicrophone()` calls
  `cancel` in a `finally` block.
- `Bun.spawn` can stop with an error immediately. If this happens after the
  UDP socket is open, the socket stays open. There is no reference to it. Put
  `Bun.spawn` in a `try/catch` block. Close the socket in the `catch` block.
- There are two different socket errors. One error occurs when the bind
  operation fails. The other error occurs when the bind operation is good, but
  `Bun.spawn` fails. You must correct both errors.
- When a file comes to its end, the old code closed only the queue. It did not
  close the socket or the track. Thus `readyState` showed `"ended"`, but the
  resources stayed open. Send the natural end through the same `stop()`
  function. `stop()` operates correctly more than one time.
- The werift functions `writeRtp` and `stop` are synchronous. `writeRtp` also
  tests the `stopped` flag before it uses the packet. Thus there is no race
  condition between these two functions.
- If `reader.read()` in `drain()` gives an error, the error goes out of
  `recordMicrophone()`. The audio data is then lost. The Python code has the
  same condition. This is not a new error.

## realtime (legacy WebRTC backend)

- The `_handle` method has three `or` fallbacks for `delta`, `transcript`, and
  `error`. An empty dict is false in Python and true in JavaScript. Thus a
  message such as `{"type": "error", "error": {}}` gives a different result.
  Use `pyTruthy`.
- The constructor has `session or DEFAULT_SESSION`. This has the same problem.
  The port counts the keys of the session object.
- JavaScript has no equivalent of `asyncio.Event`. The port has an `AsyncEvent`
  class with a `wait(timeoutSeconds)` method. The timeout logic is in `wait()`.
  It is not an external `Promise.race`. Thus the timer and the waiter list have
  one owner. They release each other.
- There is no automatic test for `connect()`. A test needs a true
  `RTCPeerConnection`. The werift default configuration sends data to a public
  STUN server. The Python test suite also does not test `connect()`.
- `close()` does not clear the channel or remove its listeners. `connect()`
  does not release `pc` if `negotiate()` gives an error. The Python code has
  the same conditions. These are not new errors.

## Shared Python compatibility code

- The file `ts/src/pycompat.ts` holds `pyTruthy`, `codepointSlice`, and
  `isPlainRecord`.
- Each agent worked only in its own module. Thus the agents wrote `pyTruthy`
  two times and `codepointSlice` two times. Two copies of one rule are
  dangerous. If you correct one copy, the other copy stays incorrect. The
  code is now in one file.
- A value import must not have the `.ts` extension. A type-only import can
  have the extension, because TypeScript removes that import.

## cli

- `Renderer` reads `sys.stderr.encoding`. If it cannot write the characters
  `… ✓ ─`, it uses the characters `... * -`. The console on this computer uses
  cp1252. If you write `✓` to that console, you get an error.
- The live line shows only the last 110 characters. Thus the line stays on one
  row of the terminal.
- The parsed argument keys use the argparse format with underscores. Examples:
  `silence_ms`, `no_partials`, `raw_events`. The TypeScript code uses the same
  keys. Thus you can compare `ParsedArgs` directly with the fixtures.
- The `--device` value stays a string in the parser. Then `main()` changes a
  value with only digits into a number.
- `--stream` stops with the exit code 2 and a message. The upload route sends
  one final transcript.

## werift and Bun

- werift operates correctly with Bun. It makes a complete offer with the Opus
  audio m-line, the data channel, and the state `iceGatheringState: "complete"`
  after `setLocalDescription`. The aiortc code makes the same assumption.
- werift is TypeScript only. Thus you can use `bun build --compile`.
- There is one difference. werift gets `srflx` candidates from a default STUN
  server. aiortc gets only the host candidates. This is a note. Do not change
  it.

## Process and environment problems

- An agent in a worktree starts from the last commit. It cannot read the
  changes that you did not commit. Because of this, the first agents used old
  Python code. You must commit the changes before you start an agent.
- Git Bash on Windows can make a file with the name `NUL` in the directory.
  `NUL` is a reserved device name. Then `git add` gives the error "short read
  while indexing NUL". Delete the file.
- In `.gitignore`, write `.tmp_codex-src` without a slash at the end. An
  embedded git directory is a gitlink item. A directory pattern does not find
  a gitlink item.
- The venv comes from uv and has no `pip`. Use `uv pip install`.
- A review agent can report an error that is not correct. One review said that
  Python `Path.name` and Node `path.basename` give different results for UNC
  paths. A test on this computer shows that the two functions agree. Always
  test a review result before you change the code.
