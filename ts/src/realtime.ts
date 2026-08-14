/**
 * Legacy WebRTC realtime client.
 *
 * Ported from `codex_audio/realtime.py`. The Codex Desktop composer
 * microphone does not use this route -- see PORTING.md: the WebRTC call
 * endpoint (`/codex/realtime/calls`) currently 404s. `transcribe.ts` is the
 * working route `cli.ts` uses; this module is the older protocol, ported so
 * it is ready to use again if the endpoint returns.
 *
 * Runtime-agnostic core: global `fetch` and standard APIs only. werift
 * supplies `RTCPeerConnection` / `RTCSessionDescription` / `MediaStreamTrack`
 * -- an ordinary npm dependency verified working under Bun (see
 * PORTING.md), not a `Bun.*` API. No `Bun.*` anywhere in this file.
 *
 * `connect()` is not exercised in tests, mirroring tests_py/test_realtime.py
 * (which also never calls it): werift's default `RTCPeerConnection()`
 * reaches out to a public STUN server (`stun.l.google.com:19302`) during ICE
 * gathering, so a real connect() call needs real network access. Every other
 * method is unit-testable and is tested against the fixtures.
 */

import { MediaStreamTrack, RTCPeerConnection, RTCSessionDescription } from "werift";

import { type FetchLike, chatgptBaseUrl } from "./auth";
import { codepointSlice, pyTruthy } from "./pycompat";
import type {
  AuthLike,
  BuildSessionOptions,
  OnDelta,
  OnEvent,
  OnFinal,
  RealtimeEvent,
  SessionPayload,
  TranscriptionConfig,
  TurnDetection,
} from "./contract";

// ------------------------------------------------------------- constants
// Field names and values lifted from the binary's serde metadata.
// Codex itself uses gpt-4o-mini-transcribe; the full model is the stronger
// one and costs us nothing extra here, so it is the default.
export const DEFAULT_MODEL = "gpt-4o-transcribe";
export const CODEX_MODEL = "gpt-4o-mini-transcribe";

// Verified accepted on this lane: gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-1.
export const TRANSCRIBE_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"];

export const DEFAULT_LANGUAGE = "en";

// Codex's own transcription mode sends turn_detection: None and commits the
// buffer once, so the model transcribes the whole utterance with full
// context. server_vad (silence_duration_ms 500) is its *conversational*
// path, not this one. Segmenting is opt-in here for the same reason: each
// segment is transcribed in isolation, so cutting the audio costs accuracy.
export const DEFAULT_SILENCE_MS = 500;
export const DEFAULT_PREFIX_PADDING_MS = 300;
export const DEFAULT_VAD_THRESHOLD = 0.5;

/**
 * Session payload for a dictation call.
 *
 * `transcription` is the load-bearing key: omit it and the service still
 * runs VAD and commits items, but every transcript comes back null.
 *
 * `language` matters more than it looks. Each VAD segment is transcribed
 * independently, so with no hint the model re-guesses the language on every
 * short utterance and a stray segment comes back as Welsh or Malay. Pinning
 * it to an ISO-639-1 code stops that.
 *
 * Key insertion order matters -- see contract.ts and PORTING.md -- the
 * serialised negotiation body must be byte-identical to the Python's. This
 * function relies on two JS behaviours to get that for free: object
 * literals preserve the (non-numeric) key order they're written in, and
 * assigning a *new* property to an existing object appends it in assignment
 * order -- so building `transcription` as `{model}` and then conditionally
 * assigning `.language`/`.prompt` reproduces Python's
 * `transcription["language"] = ...` insertion-order behaviour exactly.
 */
export function buildSession(options: BuildSessionOptions = {}): SessionPayload {
  const {
    model = DEFAULT_MODEL,
    // Python: `language: str | None = DEFAULT_LANGUAGE` -- the default only
    // substitutes when the caller omits the key entirely. JS destructuring
    // defaults only trigger on `undefined`, not `null` or `""`, which
    // matches: an explicit `language: null` or `language: ""` stays as-is
    // and is then omitted below by the falsy check, never silently
    // defaulted back to "en".
    language = DEFAULT_LANGUAGE,
    prompt = null,
    silence_ms = DEFAULT_SILENCE_MS,
    prefix_padding_ms = DEFAULT_PREFIX_PADDING_MS,
    threshold = DEFAULT_VAD_THRESHOLD,
    vad = false,
    noise_reduction = null,
  } = options;

  const transcription: TranscriptionConfig = { model };
  if (language) transcription.language = language;
  if (prompt) transcription.prompt = prompt;

  const turn_detection: TurnDetection | null = vad
    ? {
        type: "server_vad",
        threshold,
        prefix_padding_ms,
        silence_duration_ms: silence_ms,
      }
    : // No VAD: nothing is transcribed until we explicitly commit the
      // buffer, giving one segment for the whole recording.
      null;

  return {
    type: "transcription",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        // Codex sends None here for transcription; near_field is its
        // conversational setting. Exposed, but off by default.
        noise_reduction: noise_reduction ? { type: noise_reduction } : null,
        turn_detection,
        transcription,
      },
    },
  };
}

export const DEFAULT_SESSION: SessionPayload = buildSession();

/**
 * A `buildSession()`-shaped payload, or an arbitrary override dict --
 * mirrors Python's plain `dict` typing for `session`/`negotiate()`'s third
 * argument. `SessionPayload` alone isn't assignable to `Record<string,
 * unknown>` (TS interfaces don't get an implicit index signature), so this
 * union is what lets a real `SessionPayload` and a loose test/override
 * object both flow through the same field without casts.
 */
export type SessionLike = SessionPayload | Record<string, unknown>;

// Codex speaks several protocol revisions; accept every transcript spelling.
export const DELTA_EVENTS: ReadonlySet<string> = new Set([
  "conversation.item.input_audio_transcription.delta",
  "conversation.input_transcript.delta",
]);
export const DONE_EVENTS: ReadonlySet<string> = new Set([
  "conversation.item.input_audio_transcription.completed",
  "conversation.input_transcript.done",
  "conversation.input_transcript.turn_marked",
]);

// ------------------------------------------------------------ negotiation

export class NegotiationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NegotiationError";
  }
}



/** Trade our SDP offer for the server's answer. Returns the answer SDP. */
export async function negotiate(
  offerSdp: string,
  auth: AuthLike,
  session: SessionLike,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const url = `${chatgptBaseUrl()}/codex/realtime/calls`;
  const headers = auth.headers();
  headers["Content-Type"] = "application/json";
  const payload = JSON.stringify({ sdp: offerSdp, session });

  // Python: timeout=60 (seconds) on httpx.post. fetch has no timeout option;
  // approximate with AbortSignal, same pattern as transcribe.ts's negotiate
  // sibling (transcribeAudio).
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: payload,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) {
    throw new NegotiationError(`${res.status} from ${url}: ${codepointSlice(text, 500)}`);
  }
  return text;
}

// ------------------------------------------------------------- transcript

/** Accumulated result of one session. */
export class Transcript {
  finals: string[];
  partial: string;

  constructor(finals: string[] = [], partial = "") {
    this.finals = finals;
    this.partial = partial;
  }

  get text(): string {
    const kept = this.finals.map((s) => s.trim()).filter((s) => s.length > 0);
    return kept.join(" ").trim();
  }
}

// --------------------------------------------------------- data channel

/**
 * Minimal shape `send()`/`handle()` need from a data channel. werift's
 * `RTCDataChannel` satisfies this structurally; tests use a plain object
 * instead of a real channel, mirroring how tests_py/test_realtime.py drives
 * `RealtimeTranscriber` via `__new__` with a fake channel object.
 */
export interface DataChannelLike {
  readyState: string;
  send(data: string): void;
}

class WaitTimeoutError extends Error {
  constructor(message = "timed out") {
    super(message);
    this.name = "WaitTimeoutError";
  }
}

/**
 * Minimal reimplementation of Python's `asyncio.Event`: a flag plus a set of
 * pending waiters, with a bounded `wait()` so `waitUntilOpen()`/`commit()`
 * can time out.
 *
 * The timeout is handled *inside* `wait()` rather than by racing an
 * externally-owned timer against it (`Promise.race(this.wait(), timeout)`).
 * `Promise.race` does not cancel its losing branch (see PORTING.md and the
 * audio module's findings), and racing two independently-owned resources
 * here would reproduce the same class of leak: a waiter left registered
 * forever after its timeout fires, or a timer left running after the event
 * was already set. Keeping both the waiter registration and the timer under
 * one roof means whichever side loses is always cleaned up by the side that
 * won.
 */
export class AsyncEvent {
  private flag = false;
  private readonly waiters = new Set<() => void>();

  isSet(): boolean {
    return this.flag;
  }

  set(): void {
    if (this.flag) return;
    this.flag = true;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  clear(): void {
    this.flag = false;
  }

  /** Resolves once set() is called; rejects with WaitTimeoutError after timeoutSeconds. */
  wait(timeoutSeconds: number): Promise<void> {
    if (this.flag) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onSet = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters.delete(onSet);
        reject(new WaitTimeoutError());
      }, timeoutSeconds * 1000);
      this.waiters.add(onSet);
    });
  }
}

// -------------------------------------------------------- transcriber

/** Streams one audio track to the service and collects the transcript. */
export class RealtimeTranscriber {
  auth: AuthLike;
  session: SessionLike;
  onDelta: OnDelta | null;
  onFinal: OnFinal | null;
  onEvent: OnEvent | null;
  transcript: Transcript = new Transcript();
  pc: RTCPeerConnection | null = null;
  lastError: Record<string, unknown> | null = null;
  /** Python: `_channel`. */
  channel: DataChannelLike | null = null;
  /** Python: `_open`. */
  openEvent: AsyncEvent = new AsyncEvent();
  /** Python: `_segment_done`. */
  segmentDoneEvent: AsyncEvent = new AsyncEvent();

  constructor(
    auth: AuthLike,
    session?: SessionLike | null,
    onDelta?: OnDelta | null,
    onFinal?: OnFinal | null,
    onEvent?: OnEvent | null,
  ) {
    this.auth = auth;
    // Python: `self.session = session or DEFAULT_SESSION` -- an `or`
    // fallback, not a null check. An explicit empty dict `{}` is falsy in
    // Python (unlike JS, where `{}` is truthy), so it is *also* replaced by
    // the default, not just a missing/null session.
    this.session = session != null && Object.keys(session).length > 0 ? session : DEFAULT_SESSION;
    this.onDelta = onDelta ?? null;
    this.onFinal = onFinal ?? null;
    this.onEvent = onEvent ?? null;
  }

  async connect(track: MediaStreamTrack): Promise<void> {
    const pc = new RTCPeerConnection();
    this.pc = pc;

    const channel = pc.createDataChannel("oai-events");
    this.channel = channel;

    channel.on("open", () => {
      this.openEvent.set();
    });

    channel.on("message", (ev: { data: string | Buffer }) => {
      let event: RealtimeEvent;
      try {
        const raw = typeof ev.data === "string" ? ev.data : ev.data.toString("utf-8");
        event = JSON.parse(raw) as RealtimeEvent;
      } catch {
        // Python: `except (ValueError, TypeError): return` -- malformed
        // JSON on the wire is swallowed silently.
        return;
      }
      this.handle(event);
    });

    pc.addTrack(track);

    const offer = await pc.createOffer();
    // werift completes ICE gathering inside setLocalDescription (verified
    // under Bun -- see PORTING.md), so pc.localDescription.sdp below is
    // already a full, non-trickle offer, matching what the Python assumes
    // about aiortc.
    await pc.setLocalDescription(offer);

    const offerSdp = pc.localDescription?.sdp;
    if (offerSdp === undefined) {
      // Defensive: unreachable in practice (werift always has a
      // localDescription immediately after setLocalDescription resolves),
      // but needed to satisfy strict null checks -- not a behavioural
      // divergence from the Python, which has no equivalent guard because
      // Python would simply raise AttributeError on `None.sdp` instead.
      throw new Error("no local description after setLocalDescription");
    }

    const answerSdp = await negotiate(offerSdp, this.auth, this.session);
    await pc.setRemoteDescription(new RTCSessionDescription(answerSdp, "answer"));
  }

  handle(event: RealtimeEvent): void {
    if (this.onEvent) this.onEvent(event);
    const etype = event.type ?? "";

    if (DELTA_EVENTS.has(etype)) {
      const delta = (pyTruthy(event.delta) ? event.delta : "") as string;
      if (delta) {
        this.transcript.partial += delta;
        if (this.onDelta) this.onDelta(delta);
      }
    } else if (DONE_EVENTS.has(etype)) {
      const text = (pyTruthy(event.transcript) ? event.transcript : this.transcript.partial) as string;
      this.transcript.partial = "";
      if (text) {
        this.transcript.finals.push(text);
        if (this.onFinal) this.onFinal(text);
      }
      this.segmentDoneEvent.set();
    } else if (etype === "error") {
      // Raising here would only be swallowed by the data-channel message
      // callback, and it would strand commit() waiting on a segment that is
      // never coming. Record it and release the waiter instead.
      this.lastError = (pyTruthy(event.error) ? event.error : event) as Record<string, unknown>;
      this.segmentDoneEvent.set();
    }
  }

  async waitUntilOpen(timeout = 30.0): Promise<void> {
    await this.openEvent.wait(timeout);
  }

  /** Push a client event up the same data channel transcripts come down. */
  send(event: RealtimeEvent): void {
    if (this.channel === null || this.channel.readyState !== "open") {
      throw new Error("data channel is not open");
    }
    this.channel.send(JSON.stringify(event));
  }

  /**
   * Close the audio buffer and wait for its transcript.
   *
   * Only meaningful with `vad=false`, where nothing is transcribed until
   * asked. The whole recording becomes one segment, so the model sees the
   * full utterance as context instead of a string of isolated fragments.
   */
  async commit(timeout = 20.0): Promise<void> {
    this.segmentDoneEvent.clear();
    this.send({ type: "input_audio_buffer.commit" });
    try {
      await this.segmentDoneEvent.wait(timeout);
    } catch (err) {
      if (!(err instanceof WaitTimeoutError)) throw err;
    }
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

  /**
   * Lets a caller write `await using transcriber = new RealtimeTranscriber(...)`
   * so the peer connection is guaranteed torn down even if something above
   * it throws mid-session -- PORTING.md rule 2 asks for `await
   * using`/`AsyncDisposable` in place of Python's `try/finally` for resource
   * cleanup. The Python has no equivalent (no context-manager protocol on
   * RealtimeTranscriber); this is an additive TS-idiom, not a ported
   * behaviour.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
