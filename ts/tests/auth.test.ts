/**
 * Mirrors tests_py/test_auth.py for ts/src/auth.ts.
 *
 * Run with `bun test` from `ts/`. Every test that touches the filesystem
 * points CODEX_HOME at a fresh temp directory and restores the original env
 * var afterward — the real `~/.codex/auth.json` (live credentials) is never
 * read or written. Every test that would hit the network stubs `fetch`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CLIENT_ID,
  ChatGPTAuth,
  DEFAULT_CHATGPT_BASE_URL,
  TOKEN_URL,
  authPath,
  chatgptBaseUrl,
  codexHome,
  jwtExp,
  type FetchLike,
} from "../src/auth";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "..", "fixtures");

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf-8")) as T;
}

function mkJwt(payload: Record<string, unknown>, pad = true): string {
  let raw = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  if (!pad) raw = raw.replace(/=+$/, "");
  return `header.${raw}.sig`;
}

let originalCodexHome: string | undefined;
let originalBaseUrl: string | undefined;
let tmpDir: string;

beforeEach(() => {
  originalCodexHome = process.env.CODEX_HOME;
  originalBaseUrl = process.env.CODEX_CHATGPT_BASE_URL;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-audio-auth-test-"));
  process.env.CODEX_HOME = tmpDir;
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalBaseUrl === undefined) delete process.env.CODEX_CHATGPT_BASE_URL;
  else process.env.CODEX_CHATGPT_BASE_URL = originalBaseUrl;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --------------------------------------------------------------- codexHome

describe("codexHome / authPath", () => {
  test("defaults to ~/.codex when CODEX_HOME unset", () => {
    delete process.env.CODEX_HOME;
    expect(codexHome()).toBe(path.join(os.homedir(), ".codex"));
  });

  test("respects CODEX_HOME env var", () => {
    const custom = path.join(tmpDir, "custom");
    process.env.CODEX_HOME = custom;
    expect(codexHome()).toBe(custom);
  });

  test("empty CODEX_HOME falls back to default (falsy in Python)", () => {
    process.env.CODEX_HOME = "";
    expect(codexHome()).toBe(path.join(os.homedir(), ".codex"));
  });

  test("authPath is codexHome/auth.json", () => {
    expect(authPath()).toBe(path.join(tmpDir, "auth.json"));
  });
});

// -------------------------------------------------------------------- jwt

describe("jwtExp", () => {
  const fixture = loadFixture<Array<{ label: string; token: string; exp: number | null }>>("jwt_exp");
  for (const c of fixture) {
    test(`fixture: ${c.label}`, () => {
      expect(jwtExp(c.token)).toBe(c.exp);
    });
  }
});

// ------------------------------------------------------------------- load

describe("ChatGPTAuth.load", () => {
  test("throws with 'No Codex credentials' when file missing", () => {
    expect(() => ChatGPTAuth.load()).toThrow(/No Codex credentials at/);
    try {
      ChatGPTAuth.load();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("codex login");
      expect(msg).toContain(path.join(tmpDir, "auth.json"));
    }
  });

  test("throws with 'no ChatGPT access_token' when access_token missing", () => {
    fs.writeFileSync(authPath(), JSON.stringify({ tokens: { refresh_token: "RT" } }), "utf-8");
    expect(() => ChatGPTAuth.load()).toThrow(/has no ChatGPT access_token/);
    try {
      ChatGPTAuth.load();
    } catch (e) {
      expect((e as Error).message).toContain("Sign in with ChatGPT");
    }
  });

  test("throws when tokens key missing entirely", () => {
    fs.writeFileSync(authPath(), JSON.stringify({ OPENAI_API_KEY: "sk-x" }), "utf-8");
    expect(() => ChatGPTAuth.load()).toThrow(/has no ChatGPT access_token/);
  });

  test("throws when tokens is explicit null", () => {
    fs.writeFileSync(authPath(), JSON.stringify({ tokens: null }), "utf-8");
    expect(() => ChatGPTAuth.load()).toThrow(/has no ChatGPT access_token/);
  });

  test("succeeds and populates all fields", () => {
    fs.writeFileSync(
      authPath(),
      JSON.stringify({
        tokens: { access_token: "AT", refresh_token: "RT", account_id: "ACC", id_token: "IT" },
        last_refresh: "2026-01-01T00:00:00Z",
      }),
      "utf-8",
    );
    const a = ChatGPTAuth.load();
    expect(a.access_token).toBe("AT");
    expect(a.refresh_token).toBe("RT");
    expect(a.account_id).toBe("ACC");
    expect(a.id_token).toBe("IT");
  });

  test("tolerates missing optional fields", () => {
    fs.writeFileSync(authPath(), JSON.stringify({ tokens: { access_token: "AT" } }), "utf-8");
    const a = ChatGPTAuth.load();
    expect(a.access_token).toBe("AT");
    expect(a.refresh_token).toBeNull();
    expect(a.account_id).toBeNull();
    expect(a.id_token).toBeNull();
  });
});

// ------------------------------------------------------------------- save

describe("ChatGPTAuth.save", () => {
  test("creates file when absent", () => {
    const a = new ChatGPTAuth("AT", "RT", "ACC", "IT");
    a.save();
    const raw = JSON.parse(fs.readFileSync(authPath(), "utf-8"));
    expect(raw.tokens).toEqual({ access_token: "AT", refresh_token: "RT", account_id: "ACC", id_token: "IT" });
    expect(raw.last_refresh).toBeDefined();
  });

  test("merges and preserves unknown top-level keys", () => {
    fs.writeFileSync(
      authPath(),
      JSON.stringify({ OPENAI_API_KEY: "sk-preserve-me", some_unknown_key: { nested: 1 } }),
      "utf-8",
    );
    const a = new ChatGPTAuth("AT2", "RT2", null, null);
    a.save();
    const raw = JSON.parse(fs.readFileSync(authPath(), "utf-8"));
    expect(raw.OPENAI_API_KEY).toBe("sk-preserve-me");
    expect(raw.some_unknown_key).toEqual({ nested: 1 });
    expect(raw.tokens.access_token).toBe("AT2");
  });

  test("merges into existing tokens object, preserving unknown token fields", () => {
    fs.writeFileSync(authPath(), JSON.stringify({ tokens: { access_token: "OLD", extra_field: "keep-me" } }), "utf-8");
    const a = new ChatGPTAuth("NEW", null, null, null);
    a.save();
    const raw = JSON.parse(fs.readFileSync(authPath(), "utf-8"));
    expect(raw.tokens.access_token).toBe("NEW");
    expect(raw.tokens.extra_field).toBe("keep-me");
  });

  test("stamps last_refresh in UTC %Y-%m-%dT%H:%M:%SZ format", () => {
    const a = new ChatGPTAuth("AT", null, null);
    a.save();
    const raw = JSON.parse(fs.readFileSync(authPath(), "utf-8"));
    expect(raw.last_refresh).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const deltaMs = Math.abs(Date.now() - Date.parse(raw.last_refresh));
    expect(deltaMs).toBeLessThan(5000);
  });

  test("writes indent=2 formatted JSON", () => {
    const a = new ChatGPTAuth("AT", null, null);
    a.save();
    const text = fs.readFileSync(authPath(), "utf-8");
    expect(text.startsWith('{\n  "')).toBe(true);
  });
});

// ----------------------------------------------------------------- expired

describe("ChatGPTAuth.expired", () => {
  const fixture = loadFixture<{ now: number; skew_seconds: number; cases: Array<{ label: string; expired: boolean }> }>(
    "auth_expired",
  );

  const tokensByLabel: Record<string, string> = {
    "expires-far-future": mkJwt({ exp: fixture.now + 3600 }),
    "expires-in-90s": mkJwt({ exp: fixture.now + 90 }),
    "expires-in-30s-inside-skew": mkJwt({ exp: fixture.now + 30 }),
    "expires-exactly-60s": mkJwt({ exp: fixture.now + 60 }),
    "already-expired": mkJwt({ exp: fixture.now - 10 }),
    "unparseable-token": "nope",
  };

  for (const c of fixture.cases) {
    test(`fixture: ${c.label}`, () => {
      const token = tokensByLabel[c.label];
      expect(token).toBeDefined();
      const a = new ChatGPTAuth(token as string, null, null);
      expect(a.expired(() => fixture.now, fixture.skew_seconds)).toBe(c.expired);
    });
  }

  test("false when token unparseable even with a far-future clock", () => {
    const a = new ChatGPTAuth("garbage", null, null);
    expect(a.expired(() => 9_999_999_999)).toBe(false);
  });
});

// ------------------------------------------------------------------ refresh

describe("ChatGPTAuth.refresh", () => {
  test("throws without refresh_token", async () => {
    const a = new ChatGPTAuth("AT", null, null);
    await expect(a.refresh()).rejects.toThrow(/run `codex login`/);
  });

  test("posts correct body and updates fields", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ access_token: "NEWAT", refresh_token: "NEWRT", id_token: "NEWIT" }), {
        status: 200,
      });
    }) as FetchLike;

    const a = new ChatGPTAuth("OLDAT", "OLDRT", "ACC", "OLDIT");
    const result = await a.refresh(fakeFetch);

    expect(capturedUrl).toBe(TOKEN_URL);
    expect(capturedBody).toEqual({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "OLDRT",
      scope: "openid profile email",
    });

    expect(result).toBe(a);
    expect(a.access_token).toBe("NEWAT");
    expect(a.refresh_token).toBe("NEWRT");
    expect(a.id_token).toBe("NEWIT");

    const raw = JSON.parse(fs.readFileSync(authPath(), "utf-8"));
    expect(raw.tokens.access_token).toBe("NEWAT");
  });

  test("falls back to existing refresh_token/id_token when absent from response", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ access_token: "NEWAT" }), { status: 200 })) as FetchLike;

    const a = new ChatGPTAuth("OLDAT", "OLDRT", "ACC", "OLDIT");
    await a.refresh(fakeFetch);

    expect(a.access_token).toBe("NEWAT");
    expect(a.refresh_token).toBe("OLDRT");
    expect(a.id_token).toBe("OLDIT");
  });

  test("uses explicit null over existing value when key present", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: "NEWAT", refresh_token: null, id_token: null }), {
        status: 200,
      })) as FetchLike;

    const a = new ChatGPTAuth("OLDAT", "OLDRT", "ACC", "OLDIT");
    await a.refresh(fakeFetch);

    expect(a.refresh_token).toBeNull();
    expect(a.id_token).toBeNull();
  });

  test("throws on HTTP error status", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as FetchLike;
    const a = new ChatGPTAuth("AT", "RT", null);
    await expect(a.refresh(fakeFetch)).rejects.toThrow();
  });
});

// -------------------------------------------------------------- ensureFresh

describe("ChatGPTAuth.ensureFresh", () => {
  test("returns self without refreshing when not expired", async () => {
    const now = 1_700_000_000;
    const token = mkJwt({ exp: now + 3600 });
    const a = new ChatGPTAuth(token, "RT", null);
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as FetchLike;

    const result = await a.ensureFresh(() => now, fakeFetch);
    expect(result).toBe(a);
    expect(called).toBe(false);
  });

  test("does not refresh when token is unparseable (expired is false)", async () => {
    const a = new ChatGPTAuth("unparseable-but-not-expired", "RT", null);
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as FetchLike;
    await a.ensureFresh(() => 1_700_000_000, fakeFetch);
    expect(called).toBe(false);
  });

  test("calls refresh when expired", async () => {
    const now = 1_700_000_000;
    const expiredToken = mkJwt({ exp: now - 10 });
    const a = new ChatGPTAuth(expiredToken, "RT", null);
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ access_token: "NEWAT" }), { status: 200 });
    }) as FetchLike;
    await a.ensureFresh(() => now, fakeFetch);
    expect(called).toBe(true);
    expect(a.access_token).toBe("NEWAT");
  });
});

// -------------------------------------------------------------------- headers

describe("ChatGPTAuth.headers", () => {
  const fixture = loadFixture<
    Array<{
      label: string;
      input: { access_token: string; refresh_token?: string | null; account_id?: string | null; id_token?: string | null };
      headers: Record<string, string>;
    }>
  >("auth_headers");

  for (const c of fixture) {
    test(`fixture: ${c.label}`, () => {
      const a = new ChatGPTAuth(
        c.input.access_token,
        c.input.refresh_token ?? null,
        c.input.account_id ?? null,
        c.input.id_token ?? null,
      );
      expect(a.headers()).toEqual(c.headers);
    });
  }

  test("empty-string account_id omits the header entirely", () => {
    const a = new ChatGPTAuth("AT", null, "");
    const h = a.headers();
    expect("ChatGPT-Account-Id" in h).toBe(false);
  });
});

// ---------------------------------------------------------------- base_url

describe("chatgptBaseUrl", () => {
  const fixture = loadFixture<{
    default: string;
    token_url: string;
    client_id: string;
    rstrip_cases: Array<{ env: string; expect: string }>;
  }>("base_url");

  test("default matches fixture", () => {
    delete process.env.CODEX_CHATGPT_BASE_URL;
    expect(chatgptBaseUrl()).toBe(fixture.default);
    expect(DEFAULT_CHATGPT_BASE_URL).toBe(fixture.default);
  });

  test("constants match fixture", () => {
    expect(TOKEN_URL).toBe(fixture.token_url);
    expect(CLIENT_ID).toBe(fixture.client_id);
  });

  for (const c of fixture.rstrip_cases) {
    test(`rstrips trailing slashes: ${c.env}`, () => {
      process.env.CODEX_CHATGPT_BASE_URL = c.env;
      expect(chatgptBaseUrl()).toBe(c.expect);
    });
  }
});
