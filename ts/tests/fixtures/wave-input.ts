/** In-memory WinMM driver. It never opens an audio device. */
import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import type { WaveInput } from "../../src/desktop/microphone.js";

export function driver(names = ["Test microphone"], firstAudioDelayMs = 0) {
	const queued: Buffer[] = [];
	const prepared = new Set<Buffer>();
	const calls: string[] = [];
	let fail: string | undefined;
	let format: Buffer | undefined;
	let selected: number | undefined;
	let memory: Buffer | undefined;
	let firstAudio: ReturnType<typeof setTimeout> | undefined;
	let hasFirstAudio = false;
	const queue = (sample: number, requestedBytes?: number) => {
		const header = queued.shift();
		if (!header) throw new Error("No queued input buffer");
		const bytes = requestedBytes ?? header.readUInt32LE(8);
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
			hasFirstAudio = false;
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
			const deliver = () => { queue(1000); hasFirstAudio = true; };
			if (firstAudioDelayMs === 0) deliver();
			else {
				// WinMM returns a full input buffer. A larger production buffer
				// must increase readiness time here too, rather than bypass the gate.
				const bufferMs = queued[0]!.readUInt32LE(8) * 1000 / format!.readUInt32LE(8);
				firstAudio = setTimeout(deliver, Math.max(firstAudioDelayMs, bufferMs));
			}
			return 0;
		},
		waveInReset: () => {
			clearTimeout(firstAudio);
			calls.push("reset");
			// Return the final partial buffer, followed by empty queued buffers.
			if (queued.length > 0) queue(3000, 240);
			while (queued.length > 0) queue(0, 0);
			return 0;
		},
		waveInUnprepareHeader: (_handle: unknown, header: Buffer) => {
			if (!prepared.delete(header)) throw new Error("Unpreparing an unknown input buffer");
			header.writeUInt32LE(0, 24);
			return 0;
		},
		waveInClose: () => {
			calls.push("close");
			if (prepared.size !== 0) throw new Error("Closing input with prepared buffers");
			return 0;
		},
	} as unknown as WaveInput;
	return {
		api, calls, prepared, queue,
		get format() { return format; },
		get selected() { return selected; },
		get hasFirstAudio() { return hasFirstAudio; },
		set failure(value: string) { fail = value; },
	};
}
