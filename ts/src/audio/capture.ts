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
// Realtime tracks (legacy WebRTC path — see codex/realtime.ts)
// ---------------------------------------------------------------------------

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
