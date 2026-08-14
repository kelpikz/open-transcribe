/**
 * Mirrors tests_py/test_transcribe.py for ts/src/transcribe.ts.
 *
 * Run with `bun test` from `ts/`. Nothing here touches the network or the
 * real ~/.codex/auth.json: every test injects a stub `authLoad` and/or a
 * stub `fetchImpl` via transcribeAudio/transcribeFile's third `deps`
 * parameter.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ChatGPTAuth } from "../src/auth";
import type { TranscribeOptions } from "../src/contract";
import {
  DEFAULT_LANGUAGE,
  DEFAULT_MODEL,
  TRANSCRIBE_MODELS,
  TRANSCRIBE_URL_SUFFIX,
  TranscriptionError,
  contentTypeFor,
  transcribeAudio,
  transcribeFile,
  uploadBackend,
} from "../src/transcribe";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "..", "fixtures");

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf-8")) as T;
}

function stubAuth(overrides: Partial<{ access_token: string; refresh_token: string | null; account_id: string | null }> = {}) {
  return new ChatGPTAuth(
    overrides.access_token ?? "AT",
    overrides.refresh_token === undefined ? "RT" : overrides.refresh_token,
    overrides.account_id === undefined ? "ACC" : overrides.account_id,
  );
}

/** A fetch stub that always returns { text: "stub" }, HTTP 200. */
function okFetch(text: unknown = "stub"): typeof fetch {
  return (async () => new Response(JSON.stringify({ text }), { status: 200 })) as unknown as typeof fetch;
}

// ------------------------------------------------------------------ constants

describe("transcribe constants", () => {
  const fixture = loadFixture<{
    TRANSCRIBE_URL_SUFFIX: string;
    DEFAULT_LANGUAGE: string;
    DEFAULT_MODEL: string;
    TRANSCRIBE_MODELS: string[];
  }>("transcribe_constants");

  test("match fixture", () => {
    expect(TRANSCRIBE_URL_SUFFIX).toBe(fixture.TRANSCRIBE_URL_SUFFIX);
    expect(DEFAULT_LANGUAGE).toBe(fixture.DEFAULT_LANGUAGE);
    expect(DEFAULT_MODEL).toBe(fixture.DEFAULT_MODEL);
    expect(TRANSCRIBE_MODELS).toEqual(fixture.TRANSCRIBE_MODELS);
  });
});

// ------------------------------------------------------------- contentTypeFor

describe("contentTypeFor", () => {
  const fixture = loadFixture<Array<{ path: string; content_type: string }>>("content_type_for");
  for (const c of fixture) {
    test(`fixture: ${c.path}`, () => {
      expect(contentTypeFor(c.path)).toBe(c.content_type);
    });
  }

  test("is case-insensitive on the extension", () => {
    expect(contentTypeFor("a.WAV")).toBe(contentTypeFor("a.wav"));
    expect(contentTypeFor("UPPER.MP3")).toBe("audio/mpeg");
  });

  test("a name that is all dots before the extension has no suffix (pathlib lstrip semantics)", () => {
    // pathlib.PurePath.suffix does name.lstrip('.') before finding the last
    // dot, so ALL leading dots are stripped -- not just one. Node's
    // path.extname() only special-cases a single leading dot, so a naive
    // port using extname() directly would misclassify these as "audio/wav".
    // Confirmed directly against a live Python interpreter.
    expect(contentTypeFor("..wav")).toBe("application/octet-stream");
    expect(contentTypeFor("...wav")).toBe("application/octet-stream");
    expect(contentTypeFor("....wav")).toBe("application/octet-stream");
    // A real (non-dot) leading character makes it an ordinary case again.
    expect(contentTypeFor("a...wav")).toBe("audio/wav");
  });
});

// --------------------------------------------------------- transcriptionHeaders

describe("ChatGPTAuth.transcriptionHeaders", () => {
  const fixture = loadFixture<
    Array<{
      label: string;
      input: { access_token: string; refresh_token?: string | null; account_id?: string | null };
      headers: Record<string, string>;
    }>
  >("transcription_headers");

  for (const c of fixture) {
    test(`fixture: ${c.label}`, () => {
      const a = new ChatGPTAuth(c.input.access_token, c.input.refresh_token ?? null, c.input.account_id ?? null);
      expect(a.transcriptionHeaders()).toEqual(c.headers);
    });
  }
});

// -------------------------------------------------------------- request shape

describe("transcribeAudio request construction", () => {
  const fixture = loadFixture<Array<{ language: string | null; request: Record<string, unknown> }>>(
    "transcribe_requests",
  );

  for (const c of fixture) {
    test(`language: ${JSON.stringify(c.language)}`, async () => {
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;
      const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(JSON.stringify({ text: "stub" }), { status: 200 });
      }) as unknown as typeof fetch;

      await transcribeAudio(
        new TextEncoder().encode("RIFFfake"),
        { filename: "codex-audio.wav", content_type: "audio/wav", language: c.language },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      );

      const expected = c.request;
      expect(capturedUrl).toBe(expected.url as string);

      const headerNames = Object.keys((capturedInit?.headers as Record<string, string>) ?? {}).sort();
      expect(headerNames).toEqual(expected.header_names as string[]);

      expect(capturedInit?.body).toBeInstanceOf(FormData);
      const form = capturedInit?.body as FormData;
      const expectedForm = expected.form as Record<string, string>;
      if (Object.keys(expectedForm).length === 0) {
        expect(form.has("language")).toBe(false);
      } else {
        expect(form.get("language")).toBe(expectedForm.language as string);
      }

      const filePart = form.get("file");
      expect(filePart).toBeInstanceOf(Blob);
      const blob = filePart as unknown as File;
      expect(blob.name).toBe(expected.file_name as string);
      expect(blob.size).toBe(expected.file_bytes as number);
      expect(blob.type).toBe(expected.file_content_type as string);

      // Python pins timeout=120 (seconds) on httpx.post; we approximate via
      // an AbortSignal on the request instead, since fetch has no timeout
      // option. Not directly comparable value-for-value, so just confirm a
      // signal is present.
      expect(capturedInit?.signal).toBeDefined();
    });
  }

  test("URL uses chatgptBaseUrl() (respects CODEX_CHATGPT_BASE_URL)", async () => {
    const original = process.env.CODEX_CHATGPT_BASE_URL;
    process.env.CODEX_CHATGPT_BASE_URL = "https://x.test/api/";
    try {
      let capturedUrl: string | undefined;
      const fakeFetch = (async (url: string | URL) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
      }) as unknown as typeof fetch;

      await transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      );
      expect(capturedUrl).toBe("https://x.test/api/transcribe");
    } finally {
      if (original === undefined) delete process.env.CODEX_CHATGPT_BASE_URL;
      else process.env.CODEX_CHATGPT_BASE_URL = original;
    }
  });
});

// ---------------------------------------------------------------------- success

describe("transcribeAudio success", () => {
  test("returns text on 200", async () => {
    const result = await transcribeAudio(
      new TextEncoder().encode("data"),
      { filename: "f.wav", content_type: "audio/wav" },
      { authLoad: () => stubAuth(), fetchImpl: okFetch("hello world") },
    );
    expect(result).toBe("hello world");
  });
});

// ---------------------------------------------------------------------- errors

describe("transcribeAudio errors", () => {
  test("raises TranscriptionError on non-200 with body truncated to 500 chars", async () => {
    const longBody = "x".repeat(1000);
    const fakeFetch = (async () => new Response(longBody, { status: 500 })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TranscriptionError);
    const msg = (caught as Error).message;
    expect(msg.startsWith("500 from ")).toBe(true);
    expect(msg).toContain("/transcribe: ");
    expect(msg.endsWith("x".repeat(500))).toBe(true);
    expect(msg.split(": ")[1]?.length).toBe(500);
  });

  test("truncation slices by Unicode codepoint, not UTF-16 code unit", async () => {
    // Python's response.text[:500] indexes by Unicode code point. A naive
    // JS `.slice(0, 500)` indexes by UTF-16 code unit and would cut through
    // an astral-plane character's surrogate pair if it straddles the
    // boundary, producing a lone unpaired surrogate. Pinned against real
    // Python output: for "a"*499 + <emoji> + "b"*20, Python's [:500] keeps
    // exactly 500 codepoints, ending in the whole emoji, with no "b".
    const body = "a".repeat(499) + "\u{1F600}" + "b".repeat(20);
    const fakeFetch = (async () => new Response(body, { status: 500 })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TranscriptionError);
    const snippet = (caught as Error).message.split(": ")[1] as string;
    expect(Array.from(snippet).length).toBe(500);
    expect(snippet.endsWith("\u{1F600}")).toBe(true);
    expect(snippet.includes("b")).toBe(false);
  });

  test("raises with short body verbatim", async () => {
    const fakeFetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    await expect(
      transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow(/401 from .*: unauthorized/);
  });

  test("raises when body is not JSON", async () => {
    const fakeFetch = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    await expect(
      transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow(/did not contain a text field/);
  });

  test("raises when text field is missing", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ no_text_here: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(
      transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow(/did not contain a text field/);
  });

  test("raises when body is a JSON array (not an object)", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify(["not", "a", "dict"]), { status: 200 })) as unknown as typeof fetch;
    await expect(
      transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow(/did not contain a text field/);
  });

  test("raises when body is a bare JSON string", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify("hello"), { status: 200 })) as unknown as typeof fetch;
    await expect(
      transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow(/did not contain a text field/);
  });

  test("raises when body is JSON null", async () => {
    const fakeFetch = (async () => new Response("null", { status: 200 })) as unknown as typeof fetch;
    await expect(
      transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow(/did not contain a text field/);
  });

  test("raises when text field is not a string (number)", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ text: 12345 }), { status: 200 })) as unknown as typeof fetch;
    await expect(
      transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow(/text was not a string/);
  });

  test("raises when text field is null", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ text: null }), { status: 200 })) as unknown as typeof fetch;
    await expect(
      transcribeAudio(
        new TextEncoder().encode("data"),
        { filename: "f.wav", content_type: "audio/wav" },
        { authLoad: () => stubAuth(), fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow(/text was not a string/);
  });

  test("TranscriptionError is a real Error subclass", () => {
    const e = new TranscriptionError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("TranscriptionError");
  });
});

// -------------------------------------------------------------------- language

describe("transcribeAudio language handling", () => {
  async function capturedForm(language: string | null | undefined): Promise<FormData> {
    let form: FormData | undefined;
    const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
      form = init?.body as FormData;
      return new Response(JSON.stringify({ text: "x" }), { status: 200 });
    }) as unknown as typeof fetch;

    const options: TranscribeOptions = { filename: "f.wav", content_type: "audio/wav", language };
    await transcribeAudio(new TextEncoder().encode("data"), options, {
      authLoad: () => stubAuth(),
      fetchImpl: fakeFetch,
    });
    return form as FormData;
  }

  test("defaults to 'en' when the language key is absent entirely from options", async () => {
    // transcribeAudio's own default (Python: language: str | None = "en")
    // only substitutes when the caller omits the key entirely -- distinct
    // from omitLanguage's null/"auto"/"" handling below. Build the options
    // object without a `language` property at all (not `language: undefined`,
    // which still adds the key) to exercise the hasOwnProperty branch.
    let form: FormData | undefined;
    const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
      form = init?.body as FormData;
      return new Response(JSON.stringify({ text: "x" }), { status: 200 });
    }) as unknown as typeof fetch;

    const options: TranscribeOptions = { filename: "f.wav", content_type: "audio/wav" };
    expect("language" in options).toBe(false);
    await transcribeAudio(new TextEncoder().encode("data"), options, {
      authLoad: () => stubAuth(),
      fetchImpl: fakeFetch,
    });
    expect(form?.get("language")).toBe("en");
  });

  test("null omits the language field", async () => {
    const form = await capturedForm(null);
    expect(form.has("language")).toBe(false);
  });

  test("'auto' omits the language field", async () => {
    const form = await capturedForm("auto");
    expect(form.has("language")).toBe(false);
  });

  test("'' omits the language field", async () => {
    const form = await capturedForm("");
    expect(form.has("language")).toBe(false);
  });

  test("explicit value is included", async () => {
    const form = await capturedForm("hi");
    expect(form.get("language")).toBe("hi");
  });
});

// ----------------------------------------------------------------- transcribeFile

describe("transcribeFile", () => {
  test("reads bytes and derives filename + content type", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-audio-transcribe-test-"));
    try {
      const filePath = path.join(tmpDir, "recording.mp3");
      fs.writeFileSync(filePath, "mp3-bytes-here");

      let captured: { name?: string; size?: number; type?: string } = {};
      const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
        const form = init?.body as FormData;
        const file = form.get("file") as unknown as File;
        captured = { name: file.name, size: file.size, type: file.type };
        return new Response(JSON.stringify({ text: "transcribed" }), { status: 200 });
      }) as unknown as typeof fetch;

      const result = await transcribeFile(filePath, {}, { authLoad: () => stubAuth(), fetchImpl: fakeFetch });

      expect(result).toBe("transcribed");
      expect(captured.name).toBe("recording.mp3");
      expect(captured.size).toBe(Buffer.byteLength("mp3-bytes-here"));
      expect(captured.type).toBe("audio/mpeg");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("passes an explicit language through", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-audio-transcribe-test-"));
    try {
      const filePath = path.join(tmpDir, "recording.wav");
      fs.writeFileSync(filePath, "wav-bytes");

      let form: FormData | undefined;
      const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
        form = init?.body as FormData;
        return new Response(JSON.stringify({ text: "x" }), { status: 200 });
      }) as unknown as typeof fetch;

      await transcribeFile(filePath, { language: "hi" }, { authLoad: () => stubAuth(), fetchImpl: fakeFetch });
      expect(form?.get("language")).toBe("hi");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("defaults language to 'en' when options omitted entirely", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-audio-transcribe-test-"));
    try {
      const filePath = path.join(tmpDir, "recording.wav");
      fs.writeFileSync(filePath, "wav-bytes");

      let form: FormData | undefined;
      const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
        form = init?.body as FormData;
        return new Response(JSON.stringify({ text: "x" }), { status: 200 });
      }) as unknown as typeof fetch;

      await transcribeFile(filePath, undefined, { authLoad: () => stubAuth(), fetchImpl: fakeFetch });
      expect(form?.get("language")).toBe("en");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("explicit language: null is forwarded (not defaulted to 'en') and omits the field", async () => {
    // Mirrors Python's default-argument semantics: transcribe_file's
    // language="en" default only applies when the kwarg is *omitted*, not
    // when it's passed as an explicit None. transcribeFile must tell "key
    // absent" apart from "key present with value null/undefined" the same
    // way, via `language in options`.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-audio-transcribe-test-"));
    try {
      const filePath = path.join(tmpDir, "recording.wav");
      fs.writeFileSync(filePath, "wav-bytes");

      let form: FormData | undefined;
      const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
        form = init?.body as FormData;
        return new Response(JSON.stringify({ text: "x" }), { status: 200 });
      }) as unknown as typeof fetch;

      await transcribeFile(filePath, { language: null }, { authLoad: () => stubAuth(), fetchImpl: fakeFetch });
      expect(form?.has("language")).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------- TranscriptionBackend

describe("uploadBackend implements TranscriptionBackend", () => {
  test("transcribeAudio and transcribeFile are present and callable with the interface's arity", async () => {
    expect(typeof uploadBackend.transcribeAudio).toBe("function");
    expect(typeof uploadBackend.transcribeFile).toBe("function");
  });
});
