/** Isolated desktop test process: fake keys/microphone/clipboard, real sidecar and HTTP client. */
import { mock } from "bun:test";
import * as audio from "../../src/audio/index.js";

let held = false;
let scenario = "normal";
let active: TestMicrophone | null = null;

class TestMicrophone {
	private resolveExit!: () => void;
	readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });
	private failure: string | null = null;

	static async open(_args: string[], options: { onSpawn?: (mic: TestMicrophone) => void }) {
		if (scenario === "openFailure") throw new Error("test microphone failed to open");
		const mic = new TestMicrophone();
		active = mic;
		options.onSpawn?.(mic);
		if (scenario === "slowOpen") await Bun.sleep(150);
		if (scenario === "releaseOnReady") held = false;
		return mic;
	}

	begin() {}
	end() {
		if (scenario === "endFailure") throw new Error("test microphone failed to stop");
		const pcm = Buffer.alloc(48_000);
		if (scenario !== "silence") pcm.writeInt16LE(2000, 0);
		return pcm;
	}
	level() { return 0.25; }
	failureMessage() { return this.failure; }
	stop() { this.resolveExit(); }
	crash() { this.failure = "test microphone disconnected"; this.resolveExit(); }
}

process.on("message", (message: { held?: boolean; scenario?: string; crash?: boolean }) => {
	if (message.held !== undefined) held = message.held;
	if (message.scenario !== undefined) scenario = message.scenario;
	if (message.crash) active?.crash();
});

mock.module("node:child_process", () => ({ spawnSync: () => ({ error: undefined }) }));
mock.module("../../src/audio/index.js", () => ({
	...audio,
	LiveMicrophone: TestMicrophone,
	audioDeviceNames: () => ["Test microphone"],
	micInputArgs: () => [],
}));
mock.module("../../src/desktop/recording.js", () => ({
	openRecordingMicrophone: (_device: string, options: { onSpawn?: (mic: TestMicrophone) => void }) => TestMicrophone.open([], options),
}));
mock.module("../../src/desktop/win32.js", () => ({
	isKeyDown: () => held,
	foregroundWindow: () => ({ hwnd: 1, canPaste: true, title: "Test", className: "Test" }),
	maskStartMenu: () => {},
	playSound: () => {},
	setClipboardText: async (text: string) => {
		if (scenario === "copyFailure") throw new Error("test clipboard unavailable");
		process.stdout.write(`${JSON.stringify({ ev: "testClipboard", text })}\n`);
	},
}));

await import("../../src/sidecar.js");
