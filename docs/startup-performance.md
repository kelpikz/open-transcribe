# Desktop startup performance checks

Run `bun run test:startup` in `app` to check the desktop recording hotkey path on
Windows x64. The `desktop-startup` workflow runs this check on every pull request
and on pushes to `master`. Build, release, and performance workflows use the Bun
version in `.bun-version`.

The test runs the real sidecar, hotkey polling, desktop recording factory, and
native capture implementation. An in-memory WinMM driver schedules the first
audio buffer after 40 ms. It does not open a microphone or send audio to a service.
If production requests a larger buffer, delivery waits for that buffer's duration
so a buffering regression cannot be hidden by the simulated source.
Timing starts when the sidecar receives a simulated key press and ends when it
emits the recording state. Process launch and parent test IPC are outside the
measurement. Windows key delivery and indicator painting are also outside it.

The test measures fifteen presses, including the first press in the running
sidecar. After subtracting the fixed 40 ms audio delay, the limits are:

- First press overhead: 200 ms.
- Median overhead: 75 ms.
- 90th percentile overhead: 150 ms, using nearest-rank percentiles.

These limits allow runner scheduling variation while rejecting added work on the
startup path. The test also fails if recording is reported before audio arrives
or the supported native path launches ffmpeg. A negative control adds a 250 ms
delay and verifies that the budget detects it.

CI saves raw samples, summaries, runtime version, budgets, and failures in the
`desktop-startup-results` artifact, including when a timing limit fails. Set
`OPEN_TRANSCRIBE_STARTUP_REPORT` to a file path to save the same report locally.

The limits live in `app/scripts/startup-metrics.ts`. Investigate a failure before
changing them. A runtime or capture implementation change must pass the same
budget unless a deliberate new target is documented in its pull request.

For actual device startup, run `bun run benchmark:startup` in `app`. This compares
ffmpeg and desktop capture on the selected microphone over fifteen recordings
each, using the same statistical definitions. Audio is discarded locally. Device
drivers and physical microphone latency require this hardware check; the hosted
CI test cannot measure them.
