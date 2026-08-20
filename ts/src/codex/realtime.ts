/**
 * Legacy WebRTC realtime client.
 *
 * The Codex Desktop composer microphone does not use this route. It uploads a
 * completed recording to `/backend-api/transcribe`; the realtime WebRTC call
 * endpoint retained here currently returns 404. The CLI uses `transcribe.ts`
 * instead, while this module remains as a record of the older protocol.
 */

import {
	MediaStreamTrack,
	RTCPeerConnection,
	RTCSessionDescription,
	type RTCDataChannel,
} from "werift";

import { ChatGPTAuth, chatgptBaseUrl } from "./auth.js";

// Field names and values lifted from the binary's serde metadata.
// Codex itself uses gpt-4o-mini-transcribe; the full model is the stronger one
// and costs us nothing extra here, so it is the default.
export const DEFAULT_MODEL = "gpt-4o-transcribe";
export const CODEX_MODEL = "gpt-4o-mini-transcribe";

/** Verified accepted on this lane. */
export const TRANSCRIBE_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"];

export const DEFAULT_LANGUAGE = "en";

// Codex's own transcription mode sends turn_detection: null and commits the
// buffer once, so the model transcribes the whole utterance with full context.
// server_vad (silence_duration_ms 500) is its *conversational* path, not this
// one. Segmenting is opt-in here for the same reason: each segment is
// transcribed in isolation, so cutting the audio costs accuracy.
export const DEFAULT_SILENCE_MS = 500;
export const DEFAULT_PREFIX_PADDING_MS = 300;
export const DEFAULT_VAD_THRESHOLD = 0.5;

// Wire payloads keep the service's snake_case spelling.

export interface TranscriptionConfig {
  model: string;
  language?: string;
  prompt?: string;
}

export interface TurnDetection {
  type: "server_vad";
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
}

export interface SessionPayload {
  type: "transcription";
  audio: {
    input: {
      format: { type: "audio/pcm"; rate: number };
      noise_reduction: { type: string } | null;
      turn_detection: TurnDetection | null;
      transcription: TranscriptionConfig;
    };
  };
}

export interface SessionOptions {
  model?: string;
  language?: string | null;
  prompt?: string | null;
  silenceMs?: number;
  prefixPaddingMs?: number;
  threshold?: number;
  vad?: boolean;
  noiseReduction?: string | null;
}

/**
 * Session payload for a dictation call.
 *
 * `transcription` is the load-bearing key: omit it and the service still runs
 * VAD and commits items, but every transcript comes back null.
 *
 * `language` matters more than it looks. Each VAD segment is transcribed
 * independently, so with no hint the model re-guesses the language on every
 * short utterance and a stray segment comes back as Welsh or Malay. Pinning
 * it to an ISO-639-1 code stops that.
 */
export function buildSession(options: SessionOptions = {}): SessionPayload {
	const {
		model = DEFAULT_MODEL,
		language = DEFAULT_LANGUAGE,
		prompt = null,
		silenceMs = DEFAULT_SILENCE_MS,
		prefixPaddingMs = DEFAULT_PREFIX_PADDING_MS,
		threshold = DEFAULT_VAD_THRESHOLD,
		vad = false,
		noiseReduction = null,
	} = options;

	const transcription: TranscriptionConfig = { model };
	if (language) transcription.language = language;
	if (prompt) transcription.prompt = prompt;

	return {
		type: "transcription",
		audio: {
			input: {
				format: { type: "audio/pcm", rate: 24000 },
				// Codex sends null here for transcription; near_field is its
				// conversational setting. Exposed, but off by default.
				noise_reduction: noiseReduction ? { type: noiseReduction } : null,
				// No VAD: nothing is transcribed until we explicitly commit the
				// buffer, giving one segment for the whole recording.
				turn_detection: vad
					? {
							type: "server_vad",
							threshold,
							prefix_padding_ms: prefixPaddingMs,
							silence_duration_ms: silenceMs,
						}
					: null,
				transcription,
			},
		},
	};
}

export const DEFAULT_SESSION: SessionPayload = buildSession();

/** Codex speaks several protocol revisions; accept every transcript spelling. */
export const DELTA_EVENTS = new Set([
  "conversation.item.input_audio_transcription.delta",
  "conversation.input_transcript.delta",
]);
export const DONE_EVENTS = new Set([
	"conversation.item.input_audio_transcription.completed",
	"conversation.input_transcript.done",
	"conversation.input_transcript.turn_marked",
]);

export class NegotiationError extends Error {
	override readonly name = "NegotiationError";
}

/** Trade our SDP offer for the server's answer. Returns the answer SDP. */
export async function negotiate(
	offerSdp: string,
	auth: ChatGPTAuth,
	session: SessionPayload,
): Promise<string> {
	const url = `${chatgptBaseUrl()}/codex/realtime/calls`;
	const response = await fetch(url, {
		method: "POST",
		headers: { ...auth.headers(), "Content-Type": "application/json" },
		body: JSON.stringify({ sdp: offerSdp, session }),
		signal: AbortSignal.timeout(60_000),
	});
	const text = await response.text();
	if (response.status !== 200 && response.status !== 201) {
		throw new NegotiationError(
			`${response.status} from ${url}: ${text.slice(0, 500)}`,
		);
	}
	return text;
}

/** Accumulated result of one session. */
export class Transcript {
	finals: string[] = [];
	partial = "";

	get text(): string {
		return this.finals
			.map((segment) => segment.trim())
			.filter((segment) => segment.length > 0)
			.join(" ")
			.trim();
	}
}

export interface RealtimeEvent {
	type?: string;
	delta?: string;
	transcript?: string;
	error?: unknown;
	[key: string]: unknown;
}

export interface RealtimeHandlers {
	onDelta?: (delta: string) => void;
	onFinal?: (text: string) => void;
	onEvent?: (event: RealtimeEvent) => void;
}

/** Streams one audio track to the service and collects the transcript. */
export class RealtimeTranscriber {
	readonly transcript = new Transcript();
	pc: RTCPeerConnection | null = null;
	lastError: unknown = null;

	private readonly session: SessionPayload;
	private readonly handlers: RealtimeHandlers;
	private readonly opened = new Signal();
	private readonly segmentDone = new Signal();
	private channel: RTCDataChannel | null = null;

	constructor(
		private readonly auth: ChatGPTAuth,
		session: SessionPayload | null = null,
		handlers: RealtimeHandlers = {},
	) {
		this.session = session ?? DEFAULT_SESSION;
		this.handlers = handlers;
	}

	async connect(track: MediaStreamTrack): Promise<void> {
		const pc = new RTCPeerConnection();
		this.pc = pc;

		const channel = pc.createDataChannel("oai-events");
		this.channel = channel;
		channel.stateChanged.subscribe((state) => {
			if (state === "open") this.opened.set();
		});
		channel.onMessage.subscribe((raw) => {
			let event: unknown;
			try {
				event = JSON.parse(
					typeof raw === "string" ? raw : raw.toString("utf-8"),
				);
			} catch {
				return;
			}
			if (typeof event === "object" && event !== null) {
				this.handle(event as RealtimeEvent);
			}
		});

		pc.addTrack(track);

		const offer = await pc.createOffer();
		// werift completes ICE gathering inside setLocalDescription, so
		// pc.localDescription.sdp below is already a full, non-trickle offer.
		await pc.setLocalDescription(offer);
		const offerSdp = pc.localDescription?.sdp;
		if (!offerSdp) {
			throw new NegotiationError(
				"local description was not set after setLocalDescription",
			);
		}

		const answerSdp = await negotiate(offerSdp, this.auth, this.session);
		await pc.setRemoteDescription(
			new RTCSessionDescription(answerSdp, "answer"),
		);
	}

	private handle(event: RealtimeEvent): void {
		this.handlers.onEvent?.(event);
		const type = event.type ?? "";

		if (DELTA_EVENTS.has(type)) {
			const delta = event.delta || "";
			if (delta) {
				this.transcript.partial += delta;
				this.handlers.onDelta?.(delta);
			}
		} else if (DONE_EVENTS.has(type)) {
			const text = event.transcript || this.transcript.partial;
			this.transcript.partial = "";
			if (text) {
				this.transcript.finals.push(text);
				this.handlers.onFinal?.(text);
			}
			this.segmentDone.set();
		} else if (type === "error") {
			// Throwing here would only be swallowed by the data-channel callback,
			// and it would strand commit() waiting on a segment that is never
			// coming. Record it and release the waiter instead.
			this.lastError = event.error || event;
			this.segmentDone.set();
		}
	}

	async waitUntilOpen(timeoutMs = 30_000): Promise<void> {
		if (!(await this.opened.wait(timeoutMs))) {
			throw new Error(`data channel did not open within ${timeoutMs}ms`);
		}
	}

	/** Push a client event up the same data channel transcripts come down. */
	send(event: Record<string, unknown>): void {
		if (this.channel === null || this.channel.readyState !== "open") {
			throw new Error("data channel is not open");
		}
		this.channel.send(JSON.stringify(event));
	}

	/**
	 * Close the audio buffer and wait for its transcript.
	 *
	 * Only meaningful with `vad: false`, where nothing is transcribed until
	 * asked. The whole recording becomes one segment, so the model sees the full
	 * utterance as context instead of a string of isolated fragments.
	 */
	async commit(timeoutMs = 20_000): Promise<void> {
		this.segmentDone.reset();
		this.send({ type: "input_audio_buffer.commit" });
		// A timeout is not an error here: we return what we have.
		await this.segmentDone.wait(timeoutMs);
	}

	async close(): Promise<void> {
		// Any trailing partial is still real speech; don't discard it.
		if (this.transcript.partial.trim()) {
			this.transcript.finals.push(this.transcript.partial);
			this.transcript.partial = "";
		}
		if (this.pc) {
			await this.pc.close();
			this.pc = null;
		}
	}
}

/** A one-shot latch that can be reset. */
class Signal {
	private resolve: () => void = () => {};
	private promise: Promise<void> = Promise.resolve();
	private isSet = false;

	constructor() {
		this.reset();
	}

	set(): void {
		if (this.isSet) return;
		this.isSet = true;
		this.resolve();
	}

	reset(): void {
		this.isSet = false;
		this.promise = new Promise<void>((resolve) => {
			this.resolve = resolve;
		});
	}

	/** Resolve true once set, or false if the timeout elapses first. */
	async wait(timeoutMs: number): Promise<boolean> {
		if (this.isSet) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		try {
			return await Promise.race([this.promise.then(() => true), timedOut]);
		} finally {
			clearTimeout(timer);
		}
	}
}
