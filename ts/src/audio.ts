/**
 * Audio sources: live microphone, or an existing file via ffmpeg.
 *
 * Ported from `codex_audio/audio.py`. Three surfaces, in priority order:
 *
 *   1. recordMicrophone() -- the primary path, used by the CLI's upload
 *      backend. Records 24kHz mono int16 from the mic until a line arrives
 *      on stdin, returns a complete WAV file as bytes. No streaming.
 *
 *   2. listDevices() -- a human-readable device listing for `--list-devices`.
 *
 *   3. MicrophoneTrack / fileTrack() -- legacy, feed the WebRTC realtime
 *      backend (endpoint currently 404s; ported for completeness per the
 *      port-both decision in PORTING.md).
 *
 * Bun-specific: this file uses Bun.spawn/Bun.spawnSync freely (per
 * PORTING.md rule 3, Bun-only code belongs in audio.ts and cli.ts).
 *
 * Structural divergence from the Python (see PORTING.md "werift's track
 * takes RTP, not PCM"): aiortc's MediaStreamTrack.recv() returns PCM
 * AudioFrames and aiortc does Opus encoding + RTP packetization internally.
 * werift's MediaStreamTrack.writeRtp() takes already-encoded RTP packets;
 * werift does neither encoding nor packetization. So for the legacy
 * WebRTC-feeding surfaces (MicrophoneTrack, fileTrack), one ffmpeg process
 * does capture/decode + resample + Opus encode with `-f rtp` to a local UDP
 * port, read back via node:dgram and forwarded to writeRtp(). ffmpeg owns
 * packetization *and* pacing this way, which is what makes file playback
 * run at wall-clock speed (`-re`) instead of blasting the file at the
 * server in milliseconds.
 */

import * as dgram from "node:dgram";
import * as readline from "node:readline";

import { MediaStreamTrack } from "werift";

import type { AudioSource } from "./contract.ts";

// ------------------------------------------------------------- constants

/** Legacy WebRTC path constants. Mirrors codex_audio/audio.py module scope. */
export const SAMPLE_RATE = 48_000;
export const CHANNELS = 1;
export const FRAME_MS = 20;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 960

/**
 * record_microphone()'s sample rate/blocksize in the Python are inline
 * literals (24_000 / 2_400), not module constants -- named here for
 * clarity. Deliberately distinct from SAMPLE_RATE/SAMPLES_PER_FRAME above;
 * do not conflate them (see module docstring in audio.py).
 */
const RECORD_SAMPLE_RATE = 24_000;
const RECORD_BLOCK_SIZE = 2_400;

// -------------------------------------------------------- drop-oldest queue

/**
 * Bridges a push producer to a pull consumer, bounded on purpose: when full,
 * the OLDEST item is evicted to make room rather than growing unbounded or
 * blocking the producer. Stale audio is worthless for live dictation.
 *
 * Mirrors the combination of Python's `asyncio.Queue(maxsize=50)` plus
 * MicrophoneTrack._enqueue()'s evict-then-put behaviour: Python's plain
 * `queue.put_nowait()` would raise QueueFull, so _enqueue() calls
 * `get_nowait()` first to make room. push()/pop() here fold that into one
 * step.
 */
export class DropOldestQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{ resolve: (item: T) => void; reject: (err: unknown) => void }> = [];
  private closed = false;

  constructor(private readonly maxSize: number) {}

  /** Never blocks. Drops the oldest queued item if already at capacity. */
  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    if (this.items.length >= this.maxSize) {
      this.items.shift(); // drop oldest
    }
    this.items.push(item);
  }

  /** Resolves with the next item, waiting if the queue is currently empty. */
  pop(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.reject(new Error("queue closed"));
    return new Promise<T>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Rejects any pending pop() and makes future pop() calls reject too. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("queue closed"));
    }
  }

  get size(): number {
    return this.items.length;
  }
}

// ----------------------------------------------------------------- helpers

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Build a canonical 44-byte-header PCM WAV file, byte-identical to Python's
 * `wave` module for the same input (verified against `wave.open(...,
 * "wb")` writing nchannels=1, sampwidth=2, framerate=24000 -- see
 * tests_py/test_audio.py and ts/tests/audio.test.ts for the cross-check).
 */
export function buildWav(pcm: Uint8Array, sampleRate: number, channels: number, bitsPerSample: number): Uint8Array {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const riffSize = 36 + dataSize;

  const buf = new Uint8Array(44 + dataSize);
  const view = new DataView(buf.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, riffSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format: 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  buf.set(pcm, 44);

  return buf;
}

/**
 * Concatenate captured PCM chunks into a WAV file, or raise if nothing was
 * captured. Factored out of recordMicrophone() so it is testable without
 * spawning ffmpeg or touching stdin -- feed it synthetic chunks directly,
 * mirroring how the Python test feeds synthetic chunks to the sd.InputStream
 * callback.
 *
 * Mirrors: `if not chunks: raise RuntimeError("no audio was captured")`.
 */
export function finalizeRecording(chunks: Uint8Array[]): Uint8Array {
  const pcm = concatUint8Arrays(chunks);
  if (pcm.length === 0) {
    throw new Error("no audio was captured");
  }
  return buildWav(pcm, RECORD_SAMPLE_RATE, 1, 16);
}

// ------------------------------------------------------- platform capture

/**
 * ffmpeg input args for capturing from a microphone on this platform.
 * `device` mirrors Python's `device: int | str | None` (sounddevice device
 * selector) as closely as ffmpeg's very different device-addressing schemes
 * allow -- see per-branch notes.
 */
function platformAudioInputArgs(device?: string | number | null): string[] {
  switch (process.platform) {
    case "win32":
      // dshow requires an exact quoted device NAME, not an index. A string
      // device is used as-is; a number indexes into the enumerated audio
      // device list (best-effort -- dshow's own ordering, not
      // sounddevice's/PortAudio's, so indices are NOT guaranteed to match
      // between the Python and this port). No device -> first audio input.
      return ["-f", "dshow", "-i", `audio=${resolveDshowDeviceName(device)}`];
    case "darwin":
      // UNTESTED -- no macOS dev machine available. avfoundation audio-only
      // capture addresses devices by index via "-i none:<index>" (video
      // component "none" so only the audio device is opened). A string
      // device is passed straight through in case the caller already knows
      // the exact avfoundation index as a string.
      return ["-f", "avfoundation", "-i", `none:${device ?? 0}`];
    default: {
      // Linux. UNTESTED -- no Linux dev machine available. PulseAudio is
      // the common default; ALSA is offered as a structured fallback via
      // env var since ffmpeg can't auto-detect which sound server is live.
      const backend = process.env.CODEX_AUDIO_LINUX_BACKEND === "alsa" ? "alsa" : "pulse";
      const name = device === null || device === undefined ? "default" : String(device);
      return ["-f", backend, "-i", name];
    }
  }
}

function resolveDshowDeviceName(device?: string | number | null): string {
  if (typeof device === "string" && device.length > 0) return device;
  const names = listDshowAudioDeviceNames();
  const index = typeof device === "number" ? device : 0;
  const name = names[index];
  if (!name) {
    throw new Error(
      index === 0
        ? "no dshow audio input device found"
        : `no dshow audio input device at index ${index} (found ${names.length})`,
    );
  }
  return name;
}

/** Parses `ffmpeg -list_devices true -f dshow -i dummy`'s stderr listing. */
function listDshowAudioDeviceNames(): string[] {
  const proc = Bun.spawnSync(["ffmpeg", "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
  const text = new TextDecoder().decode(proc.stderr);
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.includes("Alternative name")) continue;
    const match = /"([^"]+)"\s*\(audio\)/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/**
 * str(sd.query_devices())'s equivalent: a human-readable device listing.
 * Exact formatting cannot match PortAudio's (host APIs, in/out counts,
 * default markers) -- this returns ffmpeg's own device-enumeration output,
 * which is the closest equivalently useful thing available without a
 * PortAudio binding. See report for details.
 */
export function listDevices(): string {
  if (process.platform === "win32") {
    const proc = Bun.spawnSync(["ffmpeg", "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
    return new TextDecoder().decode(proc.stderr).trim();
  }
  if (process.platform === "darwin") {
    // UNTESTED -- no macOS dev machine available.
    const proc = Bun.spawnSync([
      "ffmpeg",
      "-hide_banner",
      "-f",
      "avfoundation",
      "-list_devices",
      "true",
      "-i",
      "",
    ]);
    return new TextDecoder().decode(proc.stderr).trim();
  }
  // Linux. UNTESTED. ffmpeg has no device-enumeration flag for pulse/alsa.
  return [
    "Device listing is not available via ffmpeg on this platform (Linux).",
    'Try `pactl list short sources` (PulseAudio) or `arecord -L` (ALSA) instead.',
  ].join("\n");
}

// ---------------------------------------------------------- recordMicrophone

/** Waits for stdin to receive a line (or close), like `sys.stdin.readline()`. */
function waitForStdinLine(): Promise<void> {
  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const finish = () => {
      rl.close();
      resolve();
    };
    rl.once("line", finish);
    rl.once("close", finish);
  });
}

/**
 * Owns the ffmpeg process that captures raw PCM from the microphone to
 * stdout. AsyncDisposable so `await using` guarantees the process is killed
 * and reaped even if something above it throws -- the TS equivalent of
 * Python's `try: ... finally: stream.stop(); stream.close()`.
 */
class RawPcmCaptureSession implements AsyncDisposable {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly chunks: Uint8Array[] = [];
  private readonly drainTask: Promise<void>;
  private stopped = false;

  private constructor(proc: ReturnType<typeof Bun.spawn>) {
    this.proc = proc;
    this.drainTask = this.drain();
  }

  static spawn(device?: string | number | null): RawPcmCaptureSession {
    const inputArgs = platformAudioInputArgs(device);
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        ...inputArgs,
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ar",
        String(RECORD_SAMPLE_RATE),
        "-ac",
        "1",
        "pipe:1",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    return new RawPcmCaptureSession(proc);
  }

  private async drain(): Promise<void> {
    const stdout = this.proc.stdout as ReadableStream<Uint8Array> | undefined;
    if (!stdout) return;
    const reader = stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  get exited(): Promise<number> {
    return this.proc.exited;
  }

  get pid(): number {
    return this.proc.pid;
  }

  capturedChunks(): Uint8Array[] {
    return this.chunks;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.proc.kill();
    } catch {
      // already exited
    }
    await this.proc.exited;
    await this.drainTask;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}

/**
 * Record from the microphone until stdin receives a line, as a WAV file.
 *
 * Mirrors Python's record_microphone(): 24kHz mono int16, no streaming, no
 * partial results. Raises "no audio was captured" if nothing arrived.
 *
 * Structural divergence: Python's sd.InputStream(device=...) fails
 * synchronously and specifically (a PortAudio error naming the bad device)
 * if the device can't be opened. This port instead races the ffmpeg
 * process's exit against the stdin-line wait, so a bad device surfaces
 * indirectly as "no audio was captured" (or, if ffmpeg never exits and
 * never produces data, hangs until stdin closes) rather than as a specific
 * error naming the device -- ffmpeg's own device-open failures aren't as
 * cleanly observable from here as PortAudio's are from Python. See report.
 */
export async function recordMicrophone(device?: string | number | null): Promise<Uint8Array> {
  await using session = RawPcmCaptureSession.spawn(device);
  await Promise.race([waitForStdinLine(), session.exited]);
  await session.stop();
  return finalizeRecording(session.capturedChunks());
}

// -------------------------------------------------- legacy WebRTC tracks

function bindEphemeralUdp(socket: dgram.Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    socket.once("error", onError);
    socket.bind(0, "127.0.0.1", () => {
      socket.removeListener("error", onError);
      const address = socket.address();
      resolve(address.port);
    });
  });
}

/**
 * An AudioSource backed by one ffmpeg process that captures/decodes,
 * resamples, and Opus-encodes into RTP packets sent to a local UDP port we
 * read back via node:dgram and forward into a werift MediaStreamTrack via
 * writeRtp(). Shared by fileTrack() and MicrophoneTrack (legacy realtime
 * backend) -- the only difference between them is the ffmpeg input args
 * (decode a file with `-re` pacing, vs. capture live from a device).
 *
 * Keeps werift types out of contract.ts: AudioSource.track is `unknown`
 * there; only this file (and callers who choose to) know it's a werift
 * MediaStreamTrack.
 *
 * The RTP packets pass through a DropOldestQueue between the dgram socket
 * (push) and writeRtp() (also effectively push, but decoupled through the
 * queue so a stall downstream drops stale packets rather than growing
 * unbounded) -- preserving the Python's drop-oldest-under-pressure
 * behaviour even though werift's push-based writeRtp() doesn't strictly
 * need a queue the way aiortc's pull-based recv() did.
 */
class FfmpegRtpAudioSource implements AudioSource {
  readonly track: MediaStreamTrack;
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly socket: dgram.Socket;
  private readonly queue: DropOldestQueue<Buffer>;
  private readonly pumpTask: Promise<void>;
  private stopped = false;
  private _readyState: "live" | "ended" = "live";

  private constructor(proc: ReturnType<typeof Bun.spawn>, socket: dgram.Socket, queue: DropOldestQueue<Buffer>) {
    this.track = new MediaStreamTrack({ kind: "audio" });
    this.proc = proc;
    this.socket = socket;
    this.queue = queue;
    this.pumpTask = this.pump();
    // Flip to "ended" whenever ffmpeg exits, whether because a file was
    // exhausted, the process was killed by stop(), or it crashed.
    void this.proc.exited.then(() => {
      this._readyState = "ended";
      if (!this.stopped) {
        this.stopped = true;
        this.queue.close();
      }
    });
  }

  static async spawn(ffmpegInputAndCodecArgs: string[]): Promise<FfmpegRtpAudioSource> {
    const socket = dgram.createSocket("udp4");
    const port = await bindEphemeralUdp(socket);
    const queue = new DropOldestQueue<Buffer>(50);
    socket.on("message", (msg) => queue.push(msg));

    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        ...ffmpegInputAndCodecArgs,
        "-f",
        "rtp",
        "-payload_type",
        "111",
        `rtp://127.0.0.1:${port}`,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    return new FfmpegRtpAudioSource(proc, socket, queue);
  }

  private async pump(): Promise<void> {
    for (;;) {
      let packet: Buffer;
      try {
        packet = await this.queue.pop();
      } catch {
        return; // queue closed: stopped or ffmpeg exited
      }
      if (this.stopped) return;
      try {
        this.track.writeRtp(packet);
      } catch {
        // A malformed/truncated UDP datagram shouldn't kill the pump loop.
      }
    }
  }

  get readyState(): string {
    return this._readyState;
  }

  /** Exposed for tests to assert no orphaned ffmpeg process after stop(). */
  get ffmpegPid(): number {
    return this.proc.pid;
  }

  /** Safe to call more than once; swallows errors, like Python's stop(). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.close();
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
    try {
      this.socket.close();
    } catch {
      // ignore
    }
    try {
      this.track.stop();
    } catch {
      // ignore
    }
    this._readyState = "ended";
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.stop();
    await this.pumpTask.catch(() => {});
    await this.proc.exited.catch(() => {});
  }
}

/** ffprobe-based check for whether a file has any audio stream. */
function probeHasAudioStream(path: string): boolean {
  const proc = Bun.spawnSync([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    path,
  ]);
  if (!proc.success) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(`failed to probe ${path}: ${stderr || `ffprobe exited with code ${proc.exitCode}`}`);
  }
  return new TextDecoder().decode(proc.stdout).trim().length > 0;
}

/**
 * Audio track read from any file ffmpeg can decode, fed into the legacy
 * WebRTC backend.
 *
 * Mirrors Python's file_track(): raises "no audio stream found in {path}"
 * if the file has no audio stream.
 *
 * Structural divergence: Python's file_track() is synchronous (PyAV's
 * MediaPlayer opens the container inline). This port must bind a UDP
 * socket before spawning ffmpeg (to know which port to hand it), which is
 * inherently async in Node/Bun, so fileTrack() returns a Promise. The
 * probe-then-throw behaviour and error message are otherwise identical.
 *
 * Resource-keepalive: Python stashes `player` on the returned track
 * (`player.audio._player_ref = player`) to defeat GC, since MediaPlayer's
 * internal capture thread would otherwise be collected. This port has no
 * GC-of-a-live-process problem -- the ffmpeg child process and dgram
 * socket are strong references held directly by the returned AudioSource
 * for as long as it's live, and stop()/[Symbol.asyncDispose]() is the only
 * way to tear them down. No _player_ref equivalent is needed.
 */
export async function fileTrack(path: string): Promise<AudioSource> {
  if (!probeHasAudioStream(path)) {
    throw new Error(`no audio stream found in ${path}`);
  }
  return FfmpegRtpAudioSource.spawn(["-re", "-i", path, "-vn", "-acodec", "libopus", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS)]);
}

/**
 * Live mic capture as a WebRTC audio track (legacy realtime backend).
 *
 * Structural divergence from Python: aiortc's MicrophoneTrack is a plain
 * class you `new`, constructed synchronously (sd.InputStream.start() is
 * synchronous). This port needs an async UDP bind before spawning ffmpeg
 * (same reason as fileTrack), and JS constructors can't be async, so
 * MicrophoneTrack here is constructed via the static async create()
 * factory instead of `new MicrophoneTrack(...)`.
 */
export class MicrophoneTrack implements AudioSource {
  private readonly inner: FfmpegRtpAudioSource;

  private constructor(inner: FfmpegRtpAudioSource) {
    this.inner = inner;
  }

  static async create(device?: string | number | null): Promise<MicrophoneTrack> {
    const inputArgs = platformAudioInputArgs(device);
    const inner = await FfmpegRtpAudioSource.spawn([
      ...inputArgs,
      "-acodec",
      "libopus",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      String(CHANNELS),
    ]);
    return new MicrophoneTrack(inner);
  }

  get track(): MediaStreamTrack {
    return this.inner.track;
  }

  get readyState(): string {
    return this.inner.readyState;
  }

  /** Exposed for tests/manual verification of no orphaned ffmpeg process. */
  get ffmpegPid(): number {
    return this.inner.ffmpegPid;
  }

  stop(): void {
    this.inner.stop();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.inner[Symbol.asyncDispose]();
  }
}
