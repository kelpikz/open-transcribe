/** Real desktop startup path with simulated keys, WinMM input, and no child audio processes. */
import { mock } from "bun:test";
import * as ffi from "bun:ffi";
import type { Pointer } from "bun:ffi";
import * as audio from "../../src/audio/index.js";
import { STARTUP_BUDGET } from "../../../app/scripts/startup-metrics.js";
import { driver } from "./wave-input.js";

const source = driver(["Test microphone"], STARTUP_BUDGET.controlledAudioDelayMs);
const realFfi = { ...ffi };
const injectedDelayMs = Number(process.env.OPEN_TRANSCRIBE_STARTUP_EXTRA_DELAY_MS ?? 0);
let held = false;
let pressedAt = 0;

process.on("message", (message: { held: boolean }) => {
	held = message.held;
	if (held) pressedAt = performance.now();
});

const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
	const event = JSON.parse(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
	if (event.ev === "state" && event.state === "recording") {
		event.startup = {
			firstAudioMs: performance.now() - pressedAt,
			nativeOpens: source.calls.filter(call => call === "open").length,
			hasFirstAudio: source.hasFirstAudio,
		};
	}
	return Reflect.apply(write, process.stdout, [`${JSON.stringify(event)}\n`, ...rest]);
}) as typeof process.stdout.write;

mock.module("node:child_process", () => ({
	spawnSync: () => {
		if (held) throw new Error("A synchronous process was launched during desktop startup.");
		return { error: undefined };
	},
	spawn: () => { throw new Error("The desktop fast path tried to launch ffmpeg."); },
}));
mock.module("../../src/audio/index.js", () => ({ ...audio, audioDeviceNames: () => ["Test microphone"] }));
mock.module("bun:ffi", () => ({
	...realFfi,
	dlopen(name: string) {
		if (name === "winmm.dll") return { symbols: {
			...source.api,
			waveInOpen(...args: Parameters<typeof source.api.waveInOpen>) {
				if (process.env.OPEN_TRANSCRIBE_STARTUP_FORCE_FALLBACK === "1") return 32;
				if (injectedDelayMs > 0) Bun.sleepSync(injectedDelayMs);
				return source.api.waveInOpen(...args);
			},
		} };
		if (name === "kernel32.dll") return { symbols: {
			GetProcessHeap: () => 1,
			HeapAlloc: (_heap: unknown, _flags: unknown, bytes: number) => source.api.allocate(bytes),
			HeapFree: (_heap: unknown, _flags: unknown, allocation: Pointer) => { source.api.free(allocation); return 1; },
		} };
		throw new Error(`Startup fixture must not load a native library: ${name}`);
	},
}));
mock.module("../../src/desktop/win32.js", () => ({
	isKeyDown: () => held,
	foregroundWindow: () => ({ hwnd: 1, canPaste: false, title: "Startup test", className: "Test" }),
	maskStartMenu: () => {},
	playSound: () => {},
}));

// A delayed parent must never cause the fixture to upload a synthetic clip.
const rejectNetwork = () => { throw new Error("Startup tests must not make network requests."); };
globalThis.fetch = Object.assign(rejectNetwork, { preconnect: rejectNetwork });
await import("../../src/sidecar.js");
