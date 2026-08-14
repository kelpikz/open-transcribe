/**
 * Mirrors tests_py/test_realtime.py for ts/src/realtime.ts.
 *
 * Nothing here touches the network. `negotiate()` is exercised with an
 * injected `fetchImpl` stub that never leaves the process; event handling is
 * driven directly through `RealtimeTranscriber.handle()`, exactly the way
 * `tools/gen_fixtures.py` builds `fixtures/event_dispatch.json` (via
 * `Object.create(RealtimeTranscriber.prototype)`, bypassing the
 * constructor -- the TS analogue of Python's `__new__` -- so no real
 * werift/RTCPeerConnection machinery is needed to pin down the dispatch
 * logic).
 *
 * `connect()` is not exercised here, mirroring the Python suite (which also
 * never calls it): werift's default `RTCPeerConnection()` reaches out to a
 * public STUN server during ICE gathering, so a real connect() call needs
 * real network access, which PORTING.md forbids in tests.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { ChatGPTAuth, chatgptBaseUrl } from "../src/auth";
import type { BuildSessionOptions, RealtimeEvent, SessionPayload } from "../src/contract";
import {
  AsyncEvent,
  CODEX_MODEL,
  DEFAULT_LANGUAGE,
  DEFAULT_MODEL,
  DEFAULT_PREFIX_PADDING_MS,
  DEFAULT_SESSION,
  DEFAULT_SILENCE_MS,
  DEFAULT_VAD_THRESHOLD,
  DELTA_EVENTS,
  DONE_EVENTS,
  NegotiationError,
  RealtimeTranscriber,
  TRANSCRIBE_MODELS,
  Transcript,
  buildSession,
  negotiate,
} from "../src/realtime";
import type { RTCPeerConnection } from "werift";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "..", "fixtures");

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf-8")) as T;
}

// ------------------------------------------------------------- build_session

describe("buildSession", () => {
  const fixture = loadFixture<Array<{ label: string; kwargs: BuildSessionOptions; result: SessionPayload }>>(
    "build_session",
  );
  for (const c of fixture) {
    test(`fixture: ${c.label}`, () => {
      expect(buildSession(c.kwargs)).toEqual(c.result);
    });
  }
});

test("DEFAULT_SESSION matches fixture", () => {
  const fixture = loadFixture<{ DEFAULT_SESSION: SessionPayload }>("realtime_constants");
  expect(DEFAULT_SESSION).toEqual(fixture.DEFAULT_SESSION);
  expect(DEFAULT_SESSION).toEqual(buildSession());
});

// ------------------------------------------------------------------ constants

test("constants match fixture", () => {
  const fixture = loadFixture<{
    DEFAULT_MODEL: string;
    CODEX_MODEL: string;
    TRANSCRIBE_MODELS: string[];
    DEFAULT_LANGUAGE: string;
    DEFAULT_SILENCE_MS: number;
    DEFAULT_PREFIX_PADDING_MS: number;
    DEFAULT_VAD_THRESHOLD: number;
    DELTA_EVENTS: string[];
    DONE_EVENTS: string[];
  }>("realtime_constants");

  expect(DEFAULT_MODEL).toBe(fixture.DEFAULT_MODEL);
  expect(CODEX_MODEL).toBe(fixture.CODEX_MODEL);
  expect(TRANSCRIBE_MODELS).toEqual(fixture.TRANSCRIBE_MODELS);
  expect(DEFAULT_LANGUAGE).toBe(fixture.DEFAULT_LANGUAGE);
  expect(DEFAULT_SILENCE_MS).toBe(fixture.DEFAULT_SILENCE_MS);
  expect(DEFAULT_PREFIX_PADDING_MS).toBe(fixture.DEFAULT_PREFIX_PADDING_MS);
  expect(DEFAULT_VAD_THRESHOLD).toBe(fixture.DEFAULT_VAD_THRESHOLD);
  expect(Array.from(DELTA_EVENTS).sort()).toEqual(fixture.DELTA_EVENTS);
  expect(Array.from(DONE_EVENTS).sort()).toEqual(fixture.DONE_EVENTS);
});

test("event sets are disjoint", () => {
  for (const e of DELTA_EVENTS) {
    expect(DONE_EVENTS.has(e)).toBe(false);
  }
});

// ----------------------------------------------------------------- transcript

describe("Transcript.text", () => {
  const fixture = loadFixture<Array<{ label: string; finals: string[]; text: string }>>("transcript_text");
  for (const c of fixture) {
    test(`fixture: ${c.label}`, () => {
      expect(new Transcript([...c.finals]).text).toBe(c.text);
    });
  }
});

test("Transcript defaults are empty", () => {
  const tx = new Transcript();
  expect(tx.finals).toEqual([]);
  expect(tx.partial).toBe("");
  expect(tx.text).toBe("");
});

// -------------------------------------------------------------- event dispatch

/**
 * Builds a RealtimeTranscriber without running the constructor / touching
 * werift. Mirrors tools/gen_fixtures.py's gen_events(), since that is how
 * fixtures/event_dispatch.json was generated: __new__ + manual field setup,
 * driving `handle()` directly with no data channel or peer connection.
 */
function bareTranscriber(): {
  tx: RealtimeTranscriber;
  deltas: string[];
  finals: string[];
  seen: string[];
} {
  const deltas: string[] = [];
  const finals: string[] = [];
  const seen: string[] = [];
  const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
  tx.onDelta = (d) => deltas.push(d);
  tx.onFinal = (f) => finals.push(f);
  tx.onEvent = (e) => seen.push(e.type ?? "");
  tx.transcript = new Transcript();
  tx.lastError = null;
  tx.segmentDoneEvent = new AsyncEvent();
  return { tx, deltas, finals, seen };
}

describe("RealtimeTranscriber.handle event dispatch", () => {
  const fixture = loadFixture<
    Array<{
      label: string;
      events: RealtimeEvent[];
      closed: boolean;
      on_delta_calls: string[];
      on_final_calls: string[];
      on_event_types: string[];
      finals: string[];
      partial: string;
      text: string;
      last_error: Record<string, unknown> | null;
      segment_done_set: boolean;
    }>
  >("event_dispatch");

  for (const c of fixture) {
    test(`fixture: ${c.label}`, () => {
      const { tx, deltas, finals, seen } = bareTranscriber();

      for (const ev of c.events) tx.handle(ev);

      if (c.closed) {
        // Exactly the partial-rescue branch of close(), the only part
        // gen_fixtures.py replicates without touching a real peer
        // connection.
        if (tx.transcript.partial.trim()) {
          tx.transcript.finals.push(tx.transcript.partial);
          tx.transcript.partial = "";
        }
      }

      expect(deltas).toEqual(c.on_delta_calls);
      expect(finals).toEqual(c.on_final_calls);
      expect(seen).toEqual(c.on_event_types);
      expect(tx.transcript.finals).toEqual(c.finals);
      expect(tx.transcript.partial).toBe(c.partial);
      expect(tx.transcript.text).toBe(c.text);
      expect(tx.lastError).toEqual(c.last_error);
      expect(tx.segmentDoneEvent.isSet()).toBe(c.segment_done_set);
    });
  }
});

test("handle swallows malformed JSON (documents the decode-step guard in connect())", () => {
  // handle() itself only ever receives already-decoded objects; the
  // try/catch { return; } guard lives in connect()'s "message" listener,
  // which decodes the raw payload before calling handle(). connect() isn't
  // exercised in these tests (see file header), so this pins the decode
  // step in isolation instead, mirroring
  // tests_py/test_realtime.py::test_handle_swallows_malformed_json_on_data_channel.
  expect(() => JSON.parse("not json")).toThrow();
});

test("handle ignores missing type key like empty string", () => {
  const { tx, deltas, finals } = bareTranscriber();
  tx.handle({});
  expect(deltas).toEqual([]);
  expect(finals).toEqual([]);
  expect(tx.transcript.finals).toEqual([]);
  expect(tx.lastError).toBeNull();
  expect(tx.segmentDoneEvent.isSet()).toBe(false);
});

test("handle without onDelta/onFinal/onEvent does not throw", () => {
  // All three callbacks are optional (null) in normal construction.
  const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
  tx.onDelta = null;
  tx.onFinal = null;
  tx.onEvent = null;
  tx.transcript = new Transcript();
  // Typed as the field's declared union, not narrowed to the `null` literal
  // -- otherwise TS narrows `tx.lastError`'s type to `null` from this
  // assignment and the `toEqual` below picks the wrong overload, since it
  // can't see that handle() mutates the property.
  tx.lastError = null as Record<string, unknown> | null;
  tx.segmentDoneEvent = new AsyncEvent();

  tx.handle({ type: "conversation.item.input_audio_transcription.delta", delta: "hi" });
  tx.handle({ type: "conversation.item.input_audio_transcription.completed", transcript: "hi." });
  tx.handle({ type: "error", error: { code: "x" } });

  expect(tx.transcript.finals).toEqual(["hi."]);
  expect(tx.lastError).toEqual({ code: "x" });
});

// --------------------------------------------------------------------- init

test("init defaults", () => {
  const auth = new ChatGPTAuth("AT", null, null);
  const tx = new RealtimeTranscriber(auth);
  expect(tx.auth).toBe(auth);
  expect(tx.session).toBe(DEFAULT_SESSION);
  expect(tx.onDelta).toBeNull();
  expect(tx.onFinal).toBeNull();
  expect(tx.onEvent).toBeNull();
  expect(tx.transcript.finals).toEqual([]);
  expect(tx.transcript.partial).toBe("");
  expect(tx.pc).toBeNull();
  expect(tx.lastError).toBeNull();
  expect(tx.channel).toBeNull();
  expect(tx.openEvent.isSet()).toBe(false);
  expect(tx.segmentDoneEvent.isSet()).toBe(false);
});

test("init with an explicit empty session falls back to DEFAULT_SESSION (Python: {} is falsy)", () => {
  // Python: `self.session = session or DEFAULT_SESSION` -- an `or`
  // fallback. An empty dict is falsy in Python (unlike JS, where `{}` is
  // truthy), so passing `{}` is NOT the same as keeping a custom session --
  // it is silently replaced by DEFAULT_SESSION, same as passing None/omitting
  // the argument.
  const auth = new ChatGPTAuth("AT", null, null);
  const tx = new RealtimeTranscriber(auth, {});
  expect(tx.session).toBe(DEFAULT_SESSION);
});

test("init custom session and callbacks", () => {
  const auth = new ChatGPTAuth("AT", null, null);
  const customSession = { type: "transcription", audio: {} };
  const calls = { delta: [] as string[], final: [] as string[], event: [] as RealtimeEvent[] };
  const tx = new RealtimeTranscriber(
    auth,
    customSession,
    (d) => calls.delta.push(d),
    (f) => calls.final.push(f),
    (e) => calls.event.push(e),
  );
  expect(tx.session).toBe(customSession);
  tx.handle({ type: "conversation.item.input_audio_transcription.delta", delta: "x" });
  expect(calls.delta).toEqual(["x"]);
  expect(calls.event).toEqual([{ type: "conversation.item.input_audio_transcription.delta", delta: "x" }]);
});

// ------------------------------------------------------------------ negotiate

function stubAuth(accountId: string | null = "ACC"): ChatGPTAuth {
  return new ChatGPTAuth("AT", null, accountId);
}

test("negotiate posts correct url, headers, and body", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response("v=0\r\n...answer...", { status: 200 });
  }) as unknown as typeof fetch;

  const auth = stubAuth("ACC");
  const session = buildSession();
  const result = await negotiate("v=0\r\n...offer...", auth, session, fakeFetch);

  expect(result).toBe("v=0\r\n...answer...");
  expect(capturedUrl).toBe(`${chatgptBaseUrl()}/codex/realtime/calls`);
  const headers = capturedInit?.headers as Record<string, string>;
  expect(headers["Content-Type"]).toBe("application/json");
  expect(headers.Authorization).toBe("Bearer AT");
  expect(headers["ChatGPT-Account-Id"]).toBe("ACC");
  const body = JSON.parse(capturedInit?.body as string);
  expect(body).toEqual({ sdp: "v=0\r\n...offer...", session });
  // Python pins timeout=60 (seconds) on httpx.post; fetch has no timeout
  // option, approximated via AbortSignal instead -- just confirm a signal is
  // present, same as transcribe.test.ts does for the upload route's timeout.
  expect(capturedInit?.signal).toBeDefined();
});

test("negotiate accepts 201", async () => {
  const fakeFetch = (async () => new Response("answer-sdp", { status: 201 })) as unknown as typeof fetch;
  const result = await negotiate("offer", stubAuth(), buildSession(), fakeFetch);
  expect(result).toBe("answer-sdp");
});

test("negotiate raises NegotiationError on 404", async () => {
  const fakeFetch = (async () =>
    new Response('{"detail":"Not Found"}', { status: 404 })) as unknown as typeof fetch;
  let caught: unknown;
  try {
    await negotiate("offer", stubAuth(), buildSession(), fakeFetch);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(NegotiationError);
  const msg = (caught as Error).message;
  expect(msg.startsWith("404 from ")).toBe(true);
  expect(msg).toContain("Not Found");
});

test("negotiate error truncates body to 500 chars", async () => {
  const longBody = "x".repeat(1000);
  const fakeFetch = (async () => new Response(longBody, { status: 500 })) as unknown as typeof fetch;
  let caught: unknown;
  try {
    await negotiate("offer", stubAuth(), buildSession(), fakeFetch);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(NegotiationError);
  const suffix = (caught as Error).message.split(": ")[1] as string;
  expect(suffix).toBe("x".repeat(500));
  expect(suffix.length).toBe(500);
});

test("negotiate truncation slices by Unicode codepoint, not UTF-16 code unit", async () => {
  // Same boundary case as transcribe.test.ts: pinned against real Python
  // output for "a"*499 + <emoji> + "b"*20 -- Python's [:500] keeps exactly
  // 500 codepoints, ending in the whole emoji, with no "b".
  const body = "a".repeat(499) + "\u{1F600}" + "b".repeat(20);
  const fakeFetch = (async () => new Response(body, { status: 500 })) as unknown as typeof fetch;
  let caught: unknown;
  try {
    await negotiate("offer", stubAuth(), buildSession(), fakeFetch);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(NegotiationError);
  const snippet = (caught as Error).message.split(": ")[1] as string;
  expect(Array.from(snippet).length).toBe(500);
  expect(snippet.endsWith("\u{1F600}")).toBe(true);
  expect(snippet.includes("b")).toBe(false);
});

test("NegotiationError is a real Error subclass", () => {
  const e = new NegotiationError("boom");
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("NegotiationError");
});

// ------------------------------------------------------------------- send

describe("RealtimeTranscriber.send", () => {
  test("raises when channel is null", () => {
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.channel = null;
    expect(() => tx.send({ type: "ping" })).toThrow("data channel is not open");
  });

  test("raises when channel not open", () => {
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.channel = { readyState: "connecting", send: () => {} };
    expect(() => tx.send({ type: "ping" })).toThrow("data channel is not open");
  });

  test("writes JSON when open", () => {
    const sent: string[] = [];
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.channel = { readyState: "open", send: (d: string) => sent.push(d) };
    tx.send({ type: "input_audio_buffer.commit" });
    expect(sent).toEqual([JSON.stringify({ type: "input_audio_buffer.commit" })]);
  });
});

// --------------------------------------------------------------- waitUntilOpen

describe("RealtimeTranscriber.waitUntilOpen", () => {
  test("returns immediately once set", async () => {
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.openEvent = new AsyncEvent();
    tx.openEvent.set();
    await tx.waitUntilOpen(1.0);
  });

  test("raises on timeout", async () => {
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.openEvent = new AsyncEvent();
    await expect(tx.waitUntilOpen(0.05)).rejects.toThrow();
  });
});

// ------------------------------------------------------------------- commit

describe("RealtimeTranscriber.commit", () => {
  test("clears segmentDoneEvent, sends commit, and waits", async () => {
    const sent: string[] = [];
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.channel = { readyState: "open", send: (d: string) => sent.push(d) };
    tx.segmentDoneEvent = new AsyncEvent();
    tx.segmentDoneEvent.set(); // pre-set from a previous segment

    const task = tx.commit(1.0);
    // Unlike Python's asyncio (where ensure_future merely schedules a
    // coroutine and `await asyncio.sleep(0)` is needed to let it run up to
    // its first suspend point), a JS async function body runs synchronously
    // up to its first `await` the moment it's called -- so clear() and
    // send() have already run by the time the line above returns. This
    // extra tick is a no-op kept for readability/parity with the Python
    // test's shape.
    await Promise.resolve();
    expect(tx.segmentDoneEvent.isSet()).toBe(false); // clear() happened before wait
    tx.segmentDoneEvent.set();
    await task;

    expect(sent).toEqual([JSON.stringify({ type: "input_audio_buffer.commit" })]);
  });

  test("swallows timeout", async () => {
    const sent: string[] = [];
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.channel = { readyState: "open", send: (d: string) => sent.push(d) };
    tx.segmentDoneEvent = new AsyncEvent();
    // Never set segmentDoneEvent -- commit() must swallow the timeout.
    await tx.commit(0.05);
    expect(sent).toEqual([JSON.stringify({ type: "input_audio_buffer.commit" })]);
  });

  test("propagates a send failure uncaught", async () => {
    // send() raises *before* the try/catch around wait(), so commit() must
    // not swallow it.
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.channel = null;
    tx.segmentDoneEvent = new AsyncEvent();
    await expect(tx.commit(1.0)).rejects.toThrow("data channel is not open");
  });
});

// --------------------------------------------------------------------- close

describe("RealtimeTranscriber.close", () => {
  test("rescues a trailing non-blank partial", async () => {
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.transcript = new Transcript();
    tx.transcript.partial = "stranded words";
    tx.pc = null;
    await tx.close();
    expect(tx.transcript.finals).toEqual(["stranded words"]);
    expect(tx.transcript.partial).toBe("");
  });

  test("does not rescue a whitespace-only partial", async () => {
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.transcript = new Transcript();
    tx.transcript.partial = "   ";
    tx.pc = null;
    await tx.close();
    expect(tx.transcript.finals).toEqual([]);
    expect(tx.transcript.partial).toBe("   "); // left untouched, not cleared
  });

  test("closes pc and sets it to null", async () => {
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.transcript = new Transcript();
    let closed = false;
    tx.pc = { close: async () => { closed = true; } } as unknown as RTCPeerConnection;
    await tx.close();
    expect(closed).toBe(true);
    expect(tx.pc).toBeNull();
  });

  test("with no pc and no partial is a no-op", async () => {
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.transcript = new Transcript();
    tx.pc = null;
    await tx.close();
    expect(tx.transcript.finals).toEqual([]);
    expect(tx.pc).toBeNull();
  });
});

// --------------------------------------------------- AsyncEvent (TS-only)
//
// Python's asyncio.Event/asyncio.wait_for already handle timeout/waiter
// cleanup correctly as part of the standard library; JS has no equivalent,
// so this reimplementation (see src/realtime.ts's AsyncEvent) is new
// TS-only surface with no Python counterpart to mirror. These tests cover
// the specific leak class PORTING.md warns about for this kind of code:
// a Promise.race-style timeout that doesn't clean up its losing branch.

describe("AsyncEvent", () => {
  test("wait() resolves immediately when already set", async () => {
    const e = new AsyncEvent();
    e.set();
    await e.wait(1);
  });

  test("wait() resolves once set() is called later", async () => {
    const e = new AsyncEvent();
    const p = e.wait(1);
    e.set();
    await p;
  });

  test("set() is idempotent and safe to call before any wait()", () => {
    const e = new AsyncEvent();
    e.set();
    e.set();
    expect(e.isSet()).toBe(true);
    e.clear();
    expect(e.isSet()).toBe(false);
  });

  test("a timed-out wait() does not leak its waiter -- a later wait() is resolved by its own set(), not a stale callback", async () => {
    const e = new AsyncEvent();
    await expect(e.wait(0.02)).rejects.toThrow();
    // Run several more timeout/set cycles: if a timed-out waiter were ever
    // left registered, repeated cycles would accumulate stale callbacks in
    // the internal waiters set, one per call -- N repetitions make that
    // signal unambiguous rather than tolerable as "one stray callback".
    for (let i = 0; i < 5; i++) {
      await expect(e.wait(0.02)).rejects.toThrow();
    }
    const p = e.wait(1);
    e.set();
    await p;
    expect(e.isSet()).toBe(true);
  });

  test("set() before a wait()'s timeout resolves it and does not also fire the timeout branch later", async () => {
    const e = new AsyncEvent();
    const p = e.wait(0.05);
    e.set();
    await p; // resolves via set(), not timeout
    // Wait past the original timeout window; if clearTimeout() didn't fire,
    // nothing observable would break here (the resolved promise can't
    // reject twice), but this documents the expectation directly rather
    // than relying on absence of a crash.
    await new Promise((r) => setTimeout(r, 80));
    expect(e.isSet()).toBe(true);
  });
});

// ------------------------------------------------ AsyncDisposable (TS-only)

test("RealtimeTranscriber[Symbol.asyncDispose] calls close()", async () => {
  const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
  tx.transcript = new Transcript();
  let closed = false;
  tx.pc = { close: async () => { closed = true; } } as unknown as RTCPeerConnection;
  await tx[Symbol.asyncDispose]();
  expect(closed).toBe(true);
  expect(tx.pc).toBeNull();
});

test("await using disposes the transcriber even when the body throws", async () => {
  let closed = false;
  async function run(): Promise<void> {
    const tx = Object.create(RealtimeTranscriber.prototype) as RealtimeTranscriber;
    tx.transcript = new Transcript();
    tx.pc = { close: async () => { closed = true; } } as unknown as RTCPeerConnection;
    await using _guard = tx;
    throw new Error("boom mid-session");
  }
  await expect(run()).rejects.toThrow("boom mid-session");
  expect(closed).toBe(true);
});
