import { expect, test } from "bun:test";
import { WindowsMicrophone, type WaveInput } from "../src/desktop/microphone.js";
import { audioDeviceNames } from "../src/audio/devices.js";
import { driver } from "./fixtures/wave-input.js";

test("native capture preserves buffer order, copies driver memory, and keeps the final partial buffer", async () => {
	const wave = driver();
	const mic = await WindowsMicrophone.open("Test microphone", {}, wave.api);
	expect(mic).not.toBeNull();
	try {
		expect(wave.format?.readUInt32LE(4)).toBe(24_000);
		expect(wave.format?.readUInt16LE(2)).toBe(1);
		expect(mic!.level()).toBeCloseTo(1000 / 32768);
		mic!.begin();
		wave.queue(2000);
		await Bun.sleep(15);
		const pcm = mic!.end();
		expect(pcm.length).toBe(960 + 960 + 240);
		expect(pcm.readInt16LE(0)).toBe(1000);
		expect(pcm.readInt16LE(960)).toBe(2000);
		expect(pcm.readInt16LE(1920)).toBe(3000);
		await mic!.exited;
		expect(wave.calls.filter(call => call === "close").length).toBe(1);
	} finally { mic!.stop(); }
});

test("native capture uses the selected device and refuses ambiguous or truncated names", async () => {
	const wave = driver(["Other microphone", "Test microphone"]);
	const mic = await WindowsMicrophone.open("Test microphone", {}, wave.api);
	mic!.stop();
	expect(wave.selected).toBe(1);
	const duplicate = driver(["Test microphone", "Test microphone"]);
	expect(await WindowsMicrophone.open("Test microphone", {}, duplicate.api)).toBeNull();
	expect(duplicate.calls).toEqual([]);
	const longName = "A microphone name that is longer than thirty one characters";
	const truncated = driver([longName]);
	expect(await WindowsMicrophone.open(longName, {}, truncated.api)).toBeNull();
	expect(truncated.calls).toEqual([]);
	expect(await WindowsMicrophone.open("Missing microphone", {}, wave.api)).toBeNull();
});

test("a truncated prefix cannot select a different native microphone", async () => {
	const longName = "A microphone name that is longer than thirty one characters";
	const selected = longName.slice(0, 31);
	for (const nativeName of [longName, selected]) {
		const wave = driver([nativeName]);
		const mic = await WindowsMicrophone.open(selected, {}, wave.api);
		try {
			expect(mic).toBeNull();
			expect(wave.calls).toEqual([]);
		} finally { mic?.stop(); }
	}
	const shortName = selected.slice(0, 30);
	const mic = await WindowsMicrophone.open(shortName, {}, driver([shortName]).api);
	try { expect(mic).not.toBeNull(); } finally { mic?.stop(); }
});

test("recorded audio stays intact when the driver recycles its entire buffer ring", async () => {
	const wave = driver();
	const mic = await WindowsMicrophone.open("Test microphone", {}, wave.api);
	try {
		mic!.begin();
		for (let cycle = 0; cycle < 3; cycle++) {
			for (let i = 0; i < 15; i++) wave.queue(2000 + cycle * 15 + i);
			await Bun.sleep(20);
		}
		const pcm = mic!.end();
		expect(pcm.length).toBe(46 * 960 + 240);
		for (let i = 0; i < 45; i++) expect(pcm.readInt16LE((i + 1) * 960)).toBe(2000 + i);
	} finally { mic!.stop(); }
});

test("an exhausted input ring reports an interruption instead of returning incomplete audio", async () => {
	const wave = driver();
	const mic = await WindowsMicrophone.open("Test microphone", {}, wave.api);
	try {
		mic!.begin();
		for (let i = 0; i < 16; i++) wave.queue(2000);
		await mic!.exited;
		expect(mic!.failureMessage()).toContain("Recording was interrupted");
		expect(() => mic!.end()).toThrow("Recording was interrupted");
	} finally { mic!.stop(); }
});

test("release before the next audio poll still rejects an exhausted ring", async () => {
	const wave = driver();
	const mic = await WindowsMicrophone.open("Test microphone", {}, wave.api);
	try {
		mic!.begin();
		for (let i = 0; i < 16; i++) wave.queue(2000);
		expect(() => mic!.end()).toThrow("Recording was interrupted");
	} finally { mic!.stop(); }
});

test("starvation during draining is detected after the first buffer is requeued", async () => {
	const wave = driver();
	let armed = false;
	let droppedBuffers = 0;
	const input: WaveInput = {
		...wave.api,
		waveInAddBuffer(...args) {
			if (armed) {
				armed = false;
				wave.queue(2222); // Capture finishes the last queued buffer during this call.
				try { wave.queue(3333); } catch { droppedBuffers++; }
			}
			return wave.api.waveInAddBuffer(...args);
		},
	};
	const mic = await WindowsMicrophone.open("Test microphone", {}, input);
	try {
		mic!.begin();
		for (let i = 0; i < 15; i++) wave.queue(1234);
		armed = true;
		await Bun.sleep(20);
		expect(droppedBuffers).toBe(1);
		expect(mic!.failureMessage()).toContain("Recording was interrupted");
		expect(() => mic!.end()).toThrow("Recording was interrupted");
		expect(wave.calls.filter(call => call === "close").length).toBe(1);
	} finally { mic!.stop(); }
});

test("starvation during release is detected before final audio is returned", async () => {
	const wave = driver();
	let armed = false;
	let droppedBuffers = 0;
	const input: WaveInput = {
		...wave.api,
		waveInReset(handle) {
			if (armed) {
				armed = false;
				wave.queue(2222);
				try { wave.queue(3333); } catch { droppedBuffers++; }
			}
			return wave.api.waveInReset(handle);
		},
	};
	const mic = await WindowsMicrophone.open("Test microphone", {}, input);
	try {
		mic!.begin();
		for (let i = 0; i < 15; i++) wave.queue(1234);
		armed = true;
		expect(() => mic!.end()).toThrow("Recording was interrupted");
		expect(droppedBuffers).toBe(1);
		expect(mic!.failureMessage()).toContain("Recording was interrupted");
		expect(wave.calls.filter(call => call === "close").length).toBe(1);
	} finally { mic!.stop(); }
});

test("native initialization failures release every prepared buffer before the ffmpeg fallback", async () => {
	for (const failure of ["open", "prepare", "queue", "start"]) {
		const wave = driver();
		wave.failure = failure;
		expect(await WindowsMicrophone.open("Test microphone", {}, wave.api)).toBeNull();
		expect(wave.prepared.size).toBe(0);
		expect(wave.calls.includes("close")).toBe(failure !== "open");
	}
});

test("cancelling native capture while it opens closes the device and does not return a recorder", async () => {
	const wave = driver();
	await expect(WindowsMicrophone.open("Test microphone", { onSpawn: mic => mic.stop() }, wave.api))
		.rejects.toThrow("cancelled");
	expect(wave.calls.filter(call => call === "close").length).toBe(1);
});

test("a native queue failure stops capture and reports the device error", async () => {
	const wave = driver();
	const mic = await WindowsMicrophone.open("Test microphone", {}, wave.api);
	try {
		wave.failure = "queue";
		wave.queue(2000);
		await mic!.exited;
		expect(mic!.failureMessage()).toContain("queue failed");
		expect(wave.calls.includes("close")).toBe(true);
	} finally { mic!.stop(); }
});

test("a stalled microphone closes and reports a failure instead of hanging", async () => {
	const wave = driver();
	const mic = await WindowsMicrophone.open("Test microphone", {}, wave.api);
	try {
		await mic!.exited;
		expect(mic!.failureMessage()).toBe("The microphone stopped delivering audio.");
		expect(wave.calls.includes("close")).toBe(true);
	} finally { mic!.stop(); }
});

// Opt in on a Windows machine with a real microphone. No audio is saved or uploaded.
test.skipIf(process.platform !== "win32" || process.arch !== "x64" || process.env.OPEN_TRANSCRIBE_TEST_MICROPHONE !== "1")(
	"native microphone survives garbage collection without dropping audio",
	async () => {
		const name = audioDeviceNames()[0];
		if (!name) throw new Error("No microphone found");
		const mic = await WindowsMicrophone.open(name);
		expect(mic).not.toBeNull();
		try {
			mic!.begin();
			const started = performance.now();
			for (let i = 0; i < 30; i++) { Bun.gc(true); await Bun.sleep(100); }
			const elapsed = performance.now() - started;
			const pcm = mic!.end();
			expect(Math.abs(pcm.length / 48 - elapsed)).toBeLessThan(100);
			expect(mic!.failureMessage()).toBeNull();
		} finally { mic!.stop(); await mic!.exited; }
	},
	10000,
);
