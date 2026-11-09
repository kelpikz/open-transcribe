/** Short-lived Windows recordings without starting ffmpeg or a DirectShow graph. */
import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { RECORD_SAMPLE_RATE, RECORD_CHANNELS } from "../audio/processing.js";

// WAVEHDR's layout below is for 64-bit Windows, the desktop app's build target.
const HEADER_BYTES = 48;
const FLAGS_OFFSET = 24;
const WHDR_DONE = 1;
const WHDR_PREPARED = 2;
const BUFFER_MS = 20;
const BUFFER_BYTES = RECORD_SAMPLE_RATE * RECORD_CHANNELS * 2 * BUFFER_MS / 1000;
const BUFFER_COUNT = 16;
const STALL_MS = 2000;

function loadWaveInput() {
	const { u32, u64, ptr: pointer } = FFIType;
	const library = dlopen("winmm.dll", {
		waveInGetNumDevs: { args: [], returns: u32 },
		waveInGetDevCapsW: { args: [u64, pointer, u32], returns: u32 },
		waveInOpen: { args: [pointer, u32, pointer, u64, u64, u32], returns: u32 },
		waveInPrepareHeader: { args: [pointer, pointer, u32], returns: u32 },
		waveInAddBuffer: { args: [pointer, pointer, u32], returns: u32 },
		waveInStart: { args: [pointer], returns: u32 },
		waveInReset: { args: [pointer], returns: u32 },
		waveInUnprepareHeader: { args: [pointer, pointer, u32], returns: u32 },
		waveInClose: { args: [pointer], returns: u32 },
	});
	const memory = dlopen("kernel32.dll", {
		GetProcessHeap: { args: [], returns: pointer },
		HeapAlloc: { args: [pointer, u32, u64], returns: pointer },
		HeapFree: { args: [pointer, u32, pointer], returns: u32 },
	});
	const heap = memory.symbols.GetProcessHeap();
	return {
		...library.symbols,
		libraries: [library, memory],
		allocate(bytes: number): Pointer {
			const allocation = memory.symbols.HeapAlloc(heap, 8, bytes); // HEAP_ZERO_MEMORY
			if (allocation === null) throw new Error("Could not allocate microphone buffers.");
			return allocation;
		},
		free(allocation: Pointer): void { memory.symbols.HeapFree(heap, 0, allocation); },
	};
}

export type WaveInput = ReturnType<typeof loadWaveInput>;
let waveInput: WaveInput | undefined;

interface AudioBuffer {
	/** Views into the native allocation, valid until all headers are unprepared. */
	header: Buffer;
	data: Buffer;
}

/** If a driver fails to return its buffers, keep their native allocation alive. */
const retainedBuffers = new Set<Pointer>();

function check(code: number, operation: string): void {
	if (code !== 0) throw new Error(`Windows microphone ${operation} failed (code ${code}).`);
}

/** Match exact names only. Truncated or ambiguous WinMM names use ffmpeg instead. */
function deviceId(name: string, wave: WaveInput): number | null {
	const matches: number[] = [];
	for (let id = 0; id < wave.waveInGetNumDevs(); id++) {
		const caps = Buffer.alloc(80); // WAVEINCAPSW
		if (wave.waveInGetDevCapsW(id, caps, caps.length) !== 0) continue;
		const found = caps.toString("utf16le", 8, 72).split("\0")[0];
		if (found === name) matches.push(id);
	}
	return matches.length === 1 ? matches[0]! : null;
}

export class WindowsMicrophone {
	private handle: Pointer | null = null;
	private memory: Pointer | null = null;
	private readonly buffers: AudioBuffer[] = [];
	private nextBuffer = 0;
	private chunks: Buffer[] = [];
	private recording = false;
	private peak = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastAudio = performance.now();
	private failure: string | null = null;
	private resolveExit!: () => void;
	readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });
	private resolveReady!: () => void;
	private readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });

	private constructor(private readonly wave: WaveInput) {}

	/** Null means that this device needs the existing ffmpeg capture path. */
	static async open(
		name: string,
		options: { onSpawn?: (mic: WindowsMicrophone) => void } = {},
		wave: WaveInput = waveInput ??= loadWaveInput(),
	): Promise<WindowsMicrophone | null> {
		const id = deviceId(name, wave);
		if (id === null) return null;
		const mic = new WindowsMicrophone(wave);
		try {
			mic.start(id);
		} catch {
			mic.stop();
			return null;
		}
		try {
			options.onSpawn?.(mic);
			await Promise.race([mic.ready, mic.exited]);
			if (mic.handle === null) throw new Error(mic.failure ?? "Microphone opening was cancelled.");
			return mic;
		} catch (error) {
			mic.stop();
			throw error;
		}
	}

	private start(id: number): void {
		const format = Buffer.alloc(18); // WAVEFORMATEX, PCM s16le, 24 kHz, mono
		format.writeUInt16LE(1, 0);
		format.writeUInt16LE(RECORD_CHANNELS, 2);
		format.writeUInt32LE(RECORD_SAMPLE_RATE, 4);
		format.writeUInt32LE(RECORD_SAMPLE_RATE * RECORD_CHANNELS * 2, 8);
		format.writeUInt16LE(RECORD_CHANNELS * 2, 12);
		format.writeUInt16LE(16, 14);
		const result = Buffer.alloc(8);
		check(this.wave.waveInOpen(result, id, format, 0, 0, 0), "open");
		this.handle = Number(result.readBigUInt64LE(0)) as Pointer;
		// The driver owns these addresses between calls. Allocate outside the JS
		// heap so garbage collection cannot invalidate an in-flight WAVEHDR.
		const stride = HEADER_BYTES + BUFFER_BYTES;
		this.memory = this.wave.allocate(stride * BUFFER_COUNT);
		for (let i = 0; i < BUFFER_COUNT; i++) {
			const header = Buffer.from(toArrayBuffer(this.memory, stride * i, HEADER_BYTES));
			const data = Buffer.from(toArrayBuffer(this.memory, stride * i + HEADER_BYTES, BUFFER_BYTES));
			header.writeBigUInt64LE(BigInt(ptr(data)), 0);
			header.writeUInt32LE(data.length, 8);
			this.buffers.push({ header, data });
			check(this.wave.waveInPrepareHeader(this.handle, header, HEADER_BYTES), "prepare");
			check(this.wave.waveInAddBuffer(this.handle, header, HEADER_BYTES), "queue");
		}
		check(this.wave.waveInStart(this.handle), "start");
		this.lastAudio = performance.now();
		this.timer = setInterval(() => {
			try {
				this.readBuffers(true);
				if (performance.now() - this.lastAudio > STALL_MS) throw new Error("The microphone stopped delivering audio.");
			} catch (error) {
				this.failure = (error as Error).message;
				this.stop();
			}
		}, 5);
	}

	private readBuffers(requeue: boolean): void {
		if (this.handle === null) return;
		if (requeue) this.checkBufferCapacity();
		for (let i = 0; i < this.buffers.length; i++) {
			const { header, data } = this.buffers[this.nextBuffer]!;
			if ((header.readUInt32LE(FLAGS_OFFSET) & WHDR_DONE) === 0) break;
			const bytes = Math.min(header.readUInt32LE(12), data.length) & ~1;
			if (bytes > 0) {
				// Windows reuses the buffer as soon as it is queued again.
				const chunk = Buffer.from(data.subarray(0, bytes));
				if (!this.recording) this.chunks = [];
				this.chunks.push(chunk);
				this.peak = 0;
				for (let offset = 0; offset < bytes; offset += 2) {
					this.peak = Math.max(this.peak, Math.abs(chunk.readInt16LE(offset)));
				}
				this.lastAudio = performance.now();
				this.resolveReady();
			}
			this.nextBuffer = (this.nextBuffer + 1) % this.buffers.length;
			if (requeue) {
				header.writeUInt32LE(0, 12);
				check(this.wave.waveInAddBuffer(this.handle, header, HEADER_BYTES), "queue");
			}
		}
	}

	/** A full returned ring means Windows may already have discarded incoming audio. */
	private checkBufferCapacity(): void {
		if (this.buffers.length > 0 && this.buffers.every(({ header }) => (header.readUInt32LE(FLAGS_OFFSET) & WHDR_DONE) !== 0)) {
			throw new Error("Recording was interrupted. Please try again.");
		}
	}

	begin(): void { this.recording = true; }
	level(): number { return this.peak / 32768; }
	failureMessage(): string | null { return this.failure; }

	/** Reset returns even the final partial buffer, preserving the end of the clip. */
	end(): Buffer {
		if (this.failure !== null) throw new Error(this.failure);
		if (this.handle !== null) {
			// Check before reset: reset itself marks all queued buffers as done.
			this.checkBufferCapacity();
			check(this.wave.waveInReset(this.handle), "stop");
			this.readBuffers(false);
		}
		this.stop();
		this.recording = false;
		const pcm = Buffer.concat(this.chunks);
		this.chunks = [];
		return pcm;
	}

	stop(): void {
		clearInterval(this.timer);
		if (this.handle === null) return;
		const handle = this.handle;
		this.handle = null;
		this.wave.waveInReset(handle);
		let released = true;
		for (const { header } of this.buffers) {
			if ((header.readUInt32LE(FLAGS_OFFSET) & WHDR_PREPARED) !== 0) {
				if (this.wave.waveInUnprepareHeader(handle, header, HEADER_BYTES) !== 0) released = false;
			}
		}
		if (this.wave.waveInClose(handle) !== 0) released = false;
		if (this.memory !== null) {
			if (released) this.wave.free(this.memory);
			else retainedBuffers.add(this.memory);
			this.memory = null;
		}
		this.buffers.length = 0;
		this.resolveExit();
	}
}
