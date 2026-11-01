/**
 * Audio sources: live microphone, or an existing file.
 *
 * Each source only starts ffmpeg against a device or a path. What comes back
 * is turned into a WAV file or an RTP track by `processing.ts`, and the input
 * arguments that name a device come from `devices.ts`.
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

import { micInputArgs, type Device } from "./devices.js";
import {
  RECORD_CHANNELS,
  RECORD_SAMPLE_RATE,
  RtpAudioSource,
  spawnFfmpeg,
  wavFromPcm,
} from "./processing.js";

// ---------------------------------------------------------------------------
// Microphone recording (the path the CLI actually uses)
// ---------------------------------------------------------------------------

/**
 * Record from the microphone until stdin receives a line, as a WAV file.
 *
 * `onReady` fires when the device delivers its first samples. Opening a
 * capture device is slow — more than half a second for dshow on Windows — so the
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

/** Resolve once stdin yields a line, or reaches end of input. */
export function waitForLine(): Promise<void> {
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
// Always-open microphone (the --listen path)
// ---------------------------------------------------------------------------

const BYTES_PER_MS = (RECORD_SAMPLE_RATE * RECORD_CHANNELS * 2) / 1000;

/**
 * A microphone that stays open, so a clip can start the moment a key goes
 * down. Opening a dshow device takes more than half a second, which would cut
 * off the first words of every clip.
 *
 * When no clip is being recorded, only the last `prerollMs` of audio are
 * kept. A clip starts with that audio, so a word that starts just before
 * the key press is not cut.
 */
export class LiveMicrophone {
  private readonly ffmpeg: ReturnType<typeof spawnFfmpeg>;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private recording = false;
  private carry: Buffer | null = null;
  private last: Buffer | null = null;

  private constructor(
    inputArgs: string[],
    private readonly prerollBytes: number,
  ) {
    this.ffmpeg = spawnFfmpeg([
      ...inputArgs,
      "-ac",
      String(RECORD_CHANNELS),
      "-ar",
      String(RECORD_SAMPLE_RATE),
      "-f",
      "s16le",
      "pipe:1",
    ]);
    this.ffmpeg.proc.stdout?.on("data", (chunk: Buffer) => this.push(chunk));
  }

  /**
   * Open the input and wait for the first samples. `inputArgs` are ffmpeg
   * input arguments; the default is the microphone from `micInputArgs`.
   */
  static async open(
    inputArgs: string[],
    options: {
      prerollMs?: number;
      /** Called as soon as ffmpeg starts, so the caller can stop it while it opens. */
      onSpawn?: (mic: LiveMicrophone) => void;
    } = {},
  ): Promise<LiveMicrophone> {
    const prerollBytes = Math.round((options.prerollMs ?? 300) * BYTES_PER_MS) & ~1;
    const mic = new LiveMicrophone(inputArgs, prerollBytes);
    options.onSpawn?.(mic);
    const first = new Promise<void>((resolve) => mic.ffmpeg.proc.stdout?.once("data", () => resolve()));
    await Promise.race([first, mic.ffmpeg.exited]);
    if (mic.bytes === 0) {
      mic.stop();
      throw new Error(mic.ffmpeg.failureMessage() ?? "no audio was captured");
    }
    return mic;
  }

  /** Resolves if ffmpeg stops, for example when the device is unplugged. */
  get exited(): Promise<void> {
    return this.ffmpeg.exited;
  }

  failureMessage(): string | null {
    return this.ffmpeg.failureMessage();
  }

  private push(data: Buffer): void {
    // Keep every stored chunk a whole number of 2-byte samples, so dropping
    // an old chunk never shifts the samples after it by one byte.
    let chunk = this.carry ? Buffer.concat([this.carry, data]) : data;
    this.carry = null;
    if (chunk.byteLength % 2 === 1) {
      this.carry = chunk.subarray(chunk.byteLength - 1);
      chunk = chunk.subarray(0, chunk.byteLength - 1);
    }
    if (chunk.byteLength === 0) return;
    this.last = chunk;
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    if (this.recording) return;
    // Drop whole old chunks while the rest still covers the pre-roll.
    while (this.chunks.length > 1 && this.bytes - (this.chunks[0]?.byteLength ?? 0) >= this.prerollBytes) {
      this.bytes -= this.chunks.shift()?.byteLength ?? 0;
    }
  }

  /** The loudness of the newest audio, 0 to 1. */
  level(): number {
    return this.last ? pcmPeak(this.last) / 32768 : 0;
  }

  /** Start a clip. It includes the pre-roll audio. */
  begin(): void {
    this.recording = true;
  }

  /** End the clip. Returns its PCM samples (s16le, 24 kHz, mono). */
  end(): Buffer {
    this.recording = false;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    return pcm;
  }

  stop(): void {
    this.ffmpeg.stop();
  }
}

/** Length of s16le mono PCM at the record rate, in milliseconds. */
export function pcmDurationMs(pcm: Uint8Array): number {
  return pcm.byteLength / BYTES_PER_MS;
}

/** The largest absolute sample value, 0 to 32768. */
export function pcmPeak(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
    const value = Math.abs(pcm.readInt16LE(i));
    if (value > peak) peak = value;
  }
  return peak;
}

// ---------------------------------------------------------------------------
// Realtime tracks (WebRTC path — see codex/realtime.ts)
//
// Both return a source that is not playing yet. Call `play()` after the data
// channel opens, or the start of the audio is lost.
// ---------------------------------------------------------------------------

/** Live mic capture as a WebRTC audio track. */
export function microphoneTrack(device?: Device): Promise<RtpAudioSource> {
  return RtpAudioSource.open(micInputArgs(device));
}

/** Audio track read from any file ffmpeg can decode, paced at realtime. */
export async function fileTrack(path: string): Promise<RtpAudioSource> {
  if (!hasAudioStream(path)) {
    throw new Error(`no audio stream found in ${path}`);
  }
  return await RtpAudioSource.open(["-re", "-i", path]);
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
