/** Capture used for each desktop shortcut press, with ffmpeg as a compatibility fallback. */
import { LiveMicrophone } from "../audio/capture.js";
import { micInputArgs } from "../audio/devices.js";
import { WindowsMicrophone } from "./microphone.js";

export interface RecordingMicrophone {
	readonly exited: Promise<void>;
	begin(): void;
	end(): Buffer;
	level(): number;
	failureMessage(): string | null;
	stop(): void;
}

export async function openRecordingMicrophone(
	device: string,
	options: { onSpawn?: (mic: RecordingMicrophone) => void } = {},
): Promise<RecordingMicrophone> {
	if (process.platform === "win32" && process.arch === "x64") {
		const mic = await WindowsMicrophone.open(device, options);
		if (mic !== null) return mic;
	}
	return LiveMicrophone.open(micInputArgs(device), { ...options, prerollMs: 0 });
}
