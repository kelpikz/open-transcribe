/**
 * Audio input devices: how to address one, and how to list them.
 *
 * Each platform names its capture devices differently, and ffmpeg is the only
 * enumerator available here, so both jobs live together.
 */

import { spawnSync } from "node:child_process";

export type Device = string | number | null | undefined;

/** ffmpeg input arguments for capturing from a microphone on this platform. */
export function micInputArgs(device?: Device): string[] {
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
