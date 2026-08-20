/**
 * Audio processing: the ffmpeg runner, and the two shapes its output takes.
 *
 *   - Raw s16le PCM on stdout, which `wavFromPcm` wraps in a WAV header for
 *     the upload route.
 *   - Opus in RTP, written to a local UDP port. `RtpAudioSource` reads that
 *     port and forwards each packet to a werift track, because werift's
 *     `writeRtp()` takes encoded packets, not PCM frames. ffmpeg also owns the
 *     pacing, which is what makes file playback run at realtime speed instead
 *     of flooding the peer.
 *
 * The sources that start ffmpeg live in `capture.ts`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { MediaStreamTrack } from "werift";

/** Realtime/WebRTC side: Opus is negotiated at 48 kHz. */
export const SAMPLE_RATE = 48_000;
export const CHANNELS = 1;
export const FRAME_MS = 20;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 960

/** Upload side: the recorder writes 24 kHz mono. */
export const RECORD_SAMPLE_RATE = 24_000;
export const RECORD_CHANNELS = 1;

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Opus over RTP (legacy WebRTC path — see codex/realtime.ts)
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

// ---------------------------------------------------------------------------
// ffmpeg process handling
// ---------------------------------------------------------------------------

export interface FfmpegProcess {
  proc: ChildProcess;
  exited: Promise<void>;
  stop: () => void;
  /** A message describing why ffmpeg failed, or null if it looked healthy. */
  failureMessage: () => string | null;
}

export function spawnFfmpeg(args: string[]): FfmpegProcess {
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
