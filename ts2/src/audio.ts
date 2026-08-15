/**
 * Audio sources: live microphone, or an existing file.
 *
 * The Python used sounddevice (PortAudio) for capture and aiortc for the
 * WebRTC track. Neither has a TypeScript equivalent, so ffmpeg does both jobs:
 *
 *   - Capture writes raw s16le PCM to stdout, which `recordMicrophone` wraps
 *     in a WAV header. This mirrors what the Python built with `wave`.
 *   - The realtime tracks need RTP, not PCM: werift's `writeRtp()` takes
 *     already-encoded packets, where aiortc accepted PCM frames and did Opus
 *     encoding and packetization itself. So ffmpeg encodes to Opus and writes
 *     `-f rtp` to a local UDP port, which is read back and forwarded packet by
 *     packet. ffmpeg also owns pacing, which is what makes file playback run
 *     at realtime speed instead of flooding the peer.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { createInterface } from "node:readline";
import { MediaStreamTrack } from "werift";

/** Realtime/WebRTC side: Opus is negotiated at 48 kHz. */
export const SAMPLE_RATE = 48_000;
export const CHANNELS = 1;
export const FRAME_MS = 20;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 960

/** Upload side: the recorder writes 24 kHz mono, as the Python did. */
export const RECORD_SAMPLE_RATE = 24_000;
export const RECORD_CHANNELS = 1;

export type Device = string | number | null | undefined;

// ---------------------------------------------------------------------------
// Microphone recording (the path the CLI actually uses)
// ---------------------------------------------------------------------------

/**
 * Record from the microphone until stdin receives a line, as a WAV file.
 *
 * `onReady` fires when the device delivers its first samples. Opening a
 * capture device is slow — about two seconds for dshow on Windows — so the
 * caller must not invite speech before this. Anything said earlier is lost.
 */
export async function recordMicrophone(
  device?: Device,
  options: { onReady?: () => void } = {},
): Promise<Uint8Array> {
  const ffmpeg = spawnFfmpeg([
    ...micInputArgs(device),
    "-ac",
    String(RECORD_CHANNELS),
    "-ar",
    String(RECORD_SAMPLE_RATE),
    "-f",
    "s16le",
    "pipe:1",
  ]);

  const chunks: Buffer[] = [];
  let markReady = (): void => {};
	const capturing = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	ffmpeg.proc.stdout?.on("data", (chunk: Buffer) => {
		console.log("writing to buffer : ", chunk);
		chunks.push(chunk);
		markReady();
	});

  try {
		// Wait for real samples before handing control back, so the prompt to
		// speak is truthful. If ffmpeg dies first, fall through to the error.
		await Promise.race([capturing, ffmpeg.exited]);
		if (chunks.length > 0) options.onReady?.();

		// Whichever comes first: the user presses Enter, or ffmpeg gives up
		// (bad device name, no such device, ffmpeg missing).
		await Promise.race([waitForLine(), ffmpeg.exited]);
	} finally {
		ffmpeg.stop();
	}
  await ffmpeg.exited;

  if (chunks.length === 0) {
    throw new Error(ffmpeg.failureMessage() ?? "no audio was captured");
  }
  return wavFromPcm(Buffer.concat(chunks), RECORD_SAMPLE_RATE, RECORD_CHANNELS);
}

/** Wrap raw little-endian 16-bit PCM in a canonical 44-byte WAV header. */
export function wavFromPcm(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const bytesPerSample = 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  header.writeUInt16LE(channels * bytesPerSample, 32); // block align
  header.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/** Resolve once stdin yields a line, or reaches end of input. */
function waitForLine(): Promise<void> {
  return new Promise((resolve) => {
    const reader = createInterface({ input: process.stdin });
    const finish = (): void => {
      reader.close();
      process.stdin.pause();
      resolve();
    };
    reader.once("line", finish);
    reader.once("close", finish);
  });
}

// ---------------------------------------------------------------------------
// Realtime tracks (legacy WebRTC path — see realtime.ts)
// ---------------------------------------------------------------------------

/**
 * An Opus-over-RTP audio track fed by ffmpeg.
 *
 * ffmpeg sends RTP to a UDP port on loopback; every datagram is forwarded
 * straight to the werift track. Stopping is idempotent.
 */
export class RtpAudioSource {
  readonly track = new MediaStreamTrack({ kind: "audio" });
  private readonly socket = createSocket("udp4");
  private ffmpeg: FfmpegProcess | null = null;
  private stopped = false;

  private constructor() {}

  /** Bind a port, start ffmpeg against it, and begin forwarding packets. */
  static async start(inputArgs: string[]): Promise<RtpAudioSource> {
    const source = new RtpAudioSource();
    source.socket.on("message", (packet) => {
      if (!source.stopped) source.track.writeRtp(packet);
    });
    // Errors here mean the socket is gone; the track simply stops receiving.
    source.socket.on("error", () => source.stop());

    const port = await new Promise<number>((resolve, reject) => {
      source.socket.once("error", reject);
      source.socket.bind(0, "127.0.0.1", () => resolve(source.socket.address().port));
    });

    source.ffmpeg = spawnFfmpeg([
      ...inputArgs,
      "-ac",
      String(CHANNELS),
      "-ar",
      String(SAMPLE_RATE),
      "-acodec",
      "libopus",
      "-b:a",
      "32k",
      "-frame_duration",
      String(FRAME_MS),
      "-f",
      "rtp",
      `rtp://127.0.0.1:${port}`,
    ]);
    return source;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ffmpeg?.stop();
    try {
      this.socket.close();
    } catch {
      // Already closed, or never bound.
    }
    this.track.stop();
  }
}

/** Live mic capture as a WebRTC audio track. */
export function microphoneTrack(device?: Device): Promise<RtpAudioSource> {
  return RtpAudioSource.start(micInputArgs(device));
}

/** Audio track read from any file ffmpeg can decode, paced at realtime. */
export async function fileTrack(path: string): Promise<RtpAudioSource> {
  if (!hasAudioStream(path)) {
    throw new Error(`no audio stream found in ${path}`);
  }
  return await RtpAudioSource.start(["-re", "-i", path]);
}

function hasAudioStream(path: string): boolean {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path],
    { encoding: "utf-8" },
  );
  // If ffprobe is missing we cannot tell; let ffmpeg be the one to complain.
  if (probe.error) return true;
  return probe.stdout.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** ffmpeg input arguments for capturing from a microphone on this platform. */
function micInputArgs(device?: Device): string[] {
  switch (process.platform) {
    case "win32":
      // dshow addresses devices by exact name, not index, so a numeric
      // --device is looked up in ffmpeg's own enumeration order.
      return ["-f", "dshow", "-i", `audio=${dshowDeviceName(device)}`];
    case "darwin":
      // avfoundation takes "<video>:<audio>"; an empty video half is silence.
      return ["-f", "avfoundation", "-i", `:${device ?? 0}`];
    default: {
      // ffmpeg cannot detect which Linux sound server is live; PulseAudio is
      // the common case, with ALSA available through the environment.
      const useAlsa = process.env.CODEX_AUDIO_LINUX_BACKEND === "alsa";
      return useAlsa
        ? ["-f", "alsa", "-i", String(device ?? "default")]
        : ["-f", "pulse", "-i", String(device ?? "default")];
    }
  }
}

function dshowDeviceName(device?: Device): string {
  if (typeof device === "string" && !/^\d+$/.test(device)) return device;
  const names = dshowAudioDeviceNames();
  const index = device == null ? 0 : Number(device);
  const name = names[index];
  if (name === undefined) {
    throw new Error(
      names.length === 0
        ? "no dshow audio input device found"
        : `no dshow audio input device at index ${index} (found ${names.length})`,
    );
  }
  return name;
}

/** Parse the audio device names out of ffmpeg's dshow listing. */
function dshowAudioDeviceNames(): string[] {
  const listing = deviceListing();
  const names: string[] = [];
  for (const line of listing.split(/\r?\n/)) {
    const match = /"([^"]+)"\s*\(audio\)/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/** ffmpeg's device enumeration, as printed. Empty when it cannot enumerate. */
function deviceListing(): string {
  switch (process.platform) {
    case "win32":
      return runForStderr("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
    case "darwin":
      return runForStderr("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "avfoundation", "-i", ""]);
    default: {
      const pactl = spawnSync("pactl", ["list", "short", "sources"], { encoding: "utf-8" });
      return pactl.error ? "" : pactl.stdout;
    }
  }
}

/** ffmpeg writes its device listing to stderr and exits non-zero. */
function runForStderr(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  if (result.error) return "";
  return result.stderr ?? "";
}

export function listDevices(): string {
  const listing = deviceListing().trim();
  return listing || "No audio input devices could be listed (is ffmpeg installed?)";
}

// ---------------------------------------------------------------------------
// ffmpeg process handling
// ---------------------------------------------------------------------------

interface FfmpegProcess {
  proc: ChildProcess;
  exited: Promise<void>;
  stop: () => void;
  /** A message describing why ffmpeg failed, or null if it looked healthy. */
  failureMessage: () => string | null;
}

function spawnFfmpeg(args: string[]): FfmpegProcess {
  const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderr: Buffer[] = [];
  proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  let spawnError: Error | null = null;
  const exited = new Promise<void>((resolve) => {
    proc.once("error", (error) => {
      spawnError = error;
      resolve();
    });
    proc.once("close", () => resolve());
  });

  return {
    proc,
    exited,
    stop: () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    },
    failureMessage: () => {
      if (spawnError !== null) {
        const error = spawnError as NodeJS.ErrnoException;
        return error.code === "ENOENT"
          ? "ffmpeg was not found on PATH; install it to capture or decode audio"
          : `ffmpeg failed to start: ${error.message}`;
      }
      const text = Buffer.concat(stderr).toString("utf-8").trim();
      return text.length > 0 ? `ffmpeg: ${text.split(/\r?\n/).slice(-3).join("; ")}` : null;
    },
  };
}
