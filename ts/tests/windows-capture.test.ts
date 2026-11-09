import { expect, test } from "bun:test";
import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { WindowsMicrophone, type WaveInput } from "../src/desktop/microphone.js";
import { audioDeviceNames } from "../src/audio/devices.js";

function driver(names = ["Test microphone"]) {
	const queued: Buffer[] = [];
	const prepared = new Set<Buffer>();
	const calls: string[] = [];
	let fail: string | undefined;
	let format: Buffer | undefined;
	let selected: number | undefined;
	let memory: Buffer | undefined;
	const queue = (sample: number, bytes = 960) => {
		const header = queued.shift();
		if (!header) throw new Error("No queued input buffer");
		if (bytes > 0) {
			const data = new DataView(toArrayBuffer(Number(header.readBigUInt64LE(0)) as Pointer, 0, bytes));
			for (let i = 0; i < bytes; i += 2) data.setInt16(i, sample, true);
		}
		header.writeUInt32LE(bytes, 12);
		header.writeUInt32LE(3, 24); // WHDR_DONE | WHDR_PREPARED
	};
	const api = {
		allocate: (bytes: number) => { memory = Buffer.alloc(bytes); return ptr(memory); },
		free: () => { calls.push("free"); memory = undefined; },
		waveInGetNumDevs: () => names.length,
		waveInGetDevCapsW: (id: number, caps: Buffer) => {
			Buffer.from(`${names[id]!.slice(0, 31)}\0`, "utf16le").copy(caps, 8);
			return 0;
		},
		waveInOpen: (result: Buffer, id: number, input: Buffer) => {
			calls.push("open");
			if (fail === "open") return 32;
			selected = id;
			format = Buffer.from(input);
			result.writeBigUInt64LE(1n);
			return 0;
		},
		waveInPrepareHeader: (_handle: unknown, header: Buffer) => {
			if (fail === "prepare" && prepared.size === 2) return 7;
			header.writeUInt32LE(2, 24);
			prepared.add(header);
			return 0;
		},
		waveInAddBuffer: (_handle: unknown, header: Buffer) => {
			if (fail === "queue") return 6;
			header.writeUInt32LE(18, 24); // WHDR_PREPARED | WHDR_INQUEUE
			queued.push(header);
			return 0;
		},
		waveInStart: () => {
			calls.push("start");
			if (fail === "start") return 6;
			queue(1000);
			return 0;
		},
		waveInReset: () => {
			calls.push("reset");
			// Simulate a partial final buffer, followed by empty returned buffers.
			if (queued.length > 0) queue(3000, 240);
			while (queued.length > 0) queue(0, 0);
			return 0;
		},
		waveInUnprepareHeader: (_handle: unknown, header: Buffer) => {
			expect(prepared.delete(header)).toBe(true);
			header.writeUInt32LE(0, 24);
			return 0;
		},
		waveInClose: () => { calls.push("close"); expect(prepared.size).toBe(0); return 0; },
	} as unknown as WaveInput;
	return {
		api, calls, prepared, queue,
		get format() { return format; },
		get selected() { return selected; },
		set failure(value: string) { fail = value; },
	};
}

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
