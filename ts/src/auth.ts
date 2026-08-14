/**
 * ChatGPT subscription auth, reused from the Codex CLI's credential store.
 *
 * Ported from `codex_audio/auth.py`. Codex stores OAuth tokens in
 * ~/.codex/auth.json:
 *
 *     {
 *       "OPENAI_API_KEY": null,
 *       "tokens": {
 *         "id_token": "...",
 *         "access_token": "...",
 *         "refresh_token": "...",
 *         "account_id": "..."
 *       },
 *       "last_refresh": "2026-08-03T18:15:00Z"
 *     }
 *
 * We read the same file and mint the same headers Codex sends, so requests
 * are billed against the ChatGPT plan rather than a platform API key.
 *
 * Runtime-agnostic: only `node:fs`, `node:path`, `node:os`, `Buffer`, and
 * global `fetch` are used, so this runs unchanged under Bun or Electron's
 * Node. No `Bun.*` APIs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AuthFile, AuthLike, StoredTokens } from "./contract.ts";

export const TOKEN_URL = "https://auth.openai.com/oauth/token";
// Same client_id the Codex CLI registers for its device/PKCE login.
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";

export function codexHome(): string {
  // Python: Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))
  // An empty-string CODEX_HOME is falsy in Python, so it falls through to
  // the default exactly like an unset one.
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".codex");
}

export function authPath(): string {
  return path.join(codexHome(), "auth.json");
}

// Python's float() string grammar accepts a digit run with single
// underscores between digits (PEP 515: "1_000" -> 1000.0, but not "1__000"
// or "_1000" or "1000_"), on either side of an optional decimal point, plus
// an optional exponent with the same underscore rule.
const PY_FLOAT_DIGITS = String.raw`\d(?:_?\d)*`;
const PY_FLOAT_NUMBER = new RegExp(
  `^(?:${PY_FLOAT_DIGITS}(?:\\.(?:${PY_FLOAT_DIGITS})?)?|\\.${PY_FLOAT_DIGITS})(?:[eE][+-]?${PY_FLOAT_DIGITS})?$`,
);

/**
 * Mimic Python's `float()` coercion closely enough for JWT `exp` claims:
 * accepts numbers, booleans (as 1/0, since Python bool is an int subclass),
 * and numeric strings — including leading/trailing whitespace, a leading
 * sign, PEP-515 underscore separators, and case-insensitive
 * inf/infinity/nan — exactly as `float(...)` does; throws for anything
 * else, exactly as `float(...)` raises `TypeError`/`ValueError`.
 */
function pyFloat(value: unknown): number {
  if (typeof value === "number") return value; // NaN round-trips, like float('nan')
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") throw new Error("could not convert string to float: ''");
    const sign = trimmed[0] === "-" ? -1 : 1;
    const unsigned = trimmed[0] === "+" || trimmed[0] === "-" ? trimmed.slice(1) : trimmed;
    const lower = unsigned.toLowerCase();
    if (lower === "inf" || lower === "infinity") return sign * Infinity;
    if (lower === "nan") return NaN; // sign is irrelevant for nan
    if (!PY_FLOAT_NUMBER.test(unsigned)) {
      throw new Error(`could not convert string to float: ${JSON.stringify(value)}`);
    }
    return sign * Number(unsigned.replace(/_/g, ""));
  }
  throw new Error("float() argument must be a string or a number");
}

/** Read `exp` out of a JWT without verifying it (we only need the clock). */
export function jwtExp(token: string): number | null {
  try {
    const parts = token.split(".");
    const payload = parts[1];
    // Python: token.split(".")[1] raises IndexError on a too-short token;
    // JS indexing silently yields undefined, so check explicitly.
    if (payload === undefined) throw new Error("no payload segment");
    // Python: payload += "=" * (-len(payload) % 4)  (re-pad unpadded base64url)
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    // Python's b64decode (validate=False) discards non-alphabet characters
    // rather than raising; Node's base64url decoder is similarly lenient.
    // Either way, garbage input fails downstream at JSON parsing.
    const decoded = Buffer.from(padded, "base64url").toString("utf-8");
    const obj: unknown = JSON.parse(decoded);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj) || !("exp" in obj)) {
      throw new Error("no exp claim");
    }
    return pyFloat((obj as Record<string, unknown>).exp);
  } catch {
    // Python: `except Exception: return None` — swallow anything.
    return null;
  }
}

/**
 * Mimic Python's truthiness for arbitrary JSON-decoded values: `None`,
 * `False`, `0`/`0.0`, `""`, `[]`, and `{}` are falsy; everything else
 * (including NaN and non-empty containers) is truthy. JS truthiness agrees
 * for scalars but disagrees for empty arrays/objects, which are always
 * truthy in JS — that gap is exactly what `raw.get("tokens") or {}` and
 * `if not access:` in the Python source rely on.
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0; // NaN !== 0 -> truthy, matching bool(float('nan'))
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** True for a JSON-decoded plain object (not null, not an array). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Best-effort Python type name for a JSON-decoded value, for error text. */
function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "float";
  if (typeof value === "object") return "dict";
  return typeof value;
}

export interface ChatGPTAuthInit {
  access_token: string;
  refresh_token?: string | null;
  account_id?: string | null;
  id_token?: string | null;
}

/** Injectable clock, seconds since epoch — mirrors Python's `time.time()`. */
export type Clock = () => number;
const realClock: Clock = () => Date.now() / 1000;

/**
 * Minimal shape of `fetch` this module needs. Declared locally (rather than
 * using `typeof fetch`) so callers can pass a plain stub function in tests
 * without also having to fake unrelated properties DOM's `Fetch` lib type
 * carries (e.g. `preconnect`).
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class ChatGPTAuth implements AuthLike {
  access_token: string;
  refresh_token: string | null;
  account_id: string | null;
  id_token: string | null;

  constructor(
    access_token: string,
    refresh_token: string | null = null,
    account_id: string | null = null,
    id_token: string | null = null,
  ) {
    this.access_token = access_token;
    this.refresh_token = refresh_token;
    this.account_id = account_id;
    this.id_token = id_token;
  }

  static load(): ChatGPTAuth {
    const p = authPath();
    if (!fs.existsSync(p)) {
      throw new Error(
        `No Codex credentials at ${p}.\n` + "Run `codex login` first — this tool reuses that session.",
      );
    }
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as AuthFile;
    // Python: raw.get("tokens") or {} — an OR fallback, not a null check, so
    // any falsy "tokens" value (missing, null, "", 0, [], {}) becomes {},
    // while a truthy-but-non-dict value (e.g. a non-empty string or list)
    // is passed straight through and blows up on the next line, same as
    // calling .get() on it here would.
    const rawTokens: unknown = raw.tokens;
    const tokens: unknown = pyTruthy(rawTokens) ? rawTokens : {};
    if (!isPlainRecord(tokens)) {
      // Python: AttributeError, e.g. 'str' object has no attribute 'get'
      throw new TypeError(`'${pyTypeName(tokens)}' object has no attribute 'get'`);
    }
    const access = (tokens as StoredTokens).access_token;
    if (!pyTruthy(access)) {
      throw new Error(
        `${p} has no ChatGPT access_token (API-key-only login?).\n` +
          "Run `codex login` and choose 'Sign in with ChatGPT'.",
      );
    }
    return new ChatGPTAuth(
      access as string,
      (tokens.refresh_token as string | null | undefined) ?? null,
      (tokens.account_id as string | null | undefined) ?? null,
      (tokens.id_token as string | null | undefined) ?? null,
    );
  }

  save(): void {
    const p = authPath();
    const raw: unknown = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : {};
    // Python: raw.setdefault("tokens", {}) requires raw itself to be a
    // dict; a top-level list/str/number/bool/null raises AttributeError
    // before "tokens" is even considered.
    if (!isPlainRecord(raw)) {
      throw new TypeError(`'${pyTypeName(raw)}' object has no attribute 'setdefault'`);
    }
    // Python: raw.setdefault("tokens", {}) only substitutes {} when the KEY
    // IS ABSENT — unlike load()'s `.get() or {}`, this is presence-based,
    // not truthiness-based, so an explicit null/0/"" left in the file is
    // passed straight to .update() and blows up there instead of being
    // quietly replaced.
    const hasTokensKey = Object.prototype.hasOwnProperty.call(raw, "tokens");
    const tokens: unknown = hasTokensKey ? raw.tokens : {};
    if (!isPlainRecord(tokens)) {
      throw new TypeError(`'${pyTypeName(tokens)}' object has no attribute 'update'`);
    }
    Object.assign(tokens, {
      access_token: this.access_token,
      refresh_token: this.refresh_token,
      account_id: this.account_id,
      id_token: this.id_token,
    });
    raw.tokens = tokens;
    raw.last_refresh = formatUtcTimestamp(new Date());
    // Python: json.dumps(raw, indent=2)
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), "utf-8");
  }

  /**
   * True once the access token is within `skew` seconds of expiring (or
   * already has). `now` defaults to the real clock but is injectable for
   * deterministic tests, mirroring the pinned-clock fixture.
   *
   * Matches Python's `exp is not None and exp - 60 < time.time()`: an
   * unparseable token (exp === null) is never considered expired here.
   */
  expired(now: Clock = realClock, skewSeconds = 60): boolean {
    const exp = jwtExp(this.access_token);
    return exp !== null && exp - skewSeconds < now();
  }

  /**
   * POST a refresh_token grant and update this instance in place.
   *
   * `fetchImpl` is injectable so tests never hit the network; defaults to
   * the global `fetch`, present in Bun and Node >= 18 (and Electron).
   */
  async refresh(fetchImpl: FetchLike = fetch): Promise<ChatGPTAuth> {
    if (!this.refresh_token) {
      throw new Error("Access token expired and no refresh_token stored; run `codex login`.");
    }
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: this.refresh_token,
        scope: "openid profile email",
      }),
    });
    // Python: r.raise_for_status()
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${TOKEN_URL}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    // Python: body["access_token"] — dict indexing, not .get(), so an
    // absent key raises KeyError uncaught rather than silently assigning
    // undefined (which would otherwise vanish from the next save() write).
    if (!("access_token" in body)) {
      throw new Error("'access_token'");
    }
    this.access_token = body.access_token as string;
    // Python: body.get("refresh_token", self.refresh_token) — falls back to
    // the existing value only when the KEY IS ABSENT, not when it's null.
    this.refresh_token = "refresh_token" in body ? ((body.refresh_token as string | null) ?? null) : this.refresh_token;
    this.id_token = "id_token" in body ? ((body.id_token as string | null) ?? null) : this.id_token;
    this.save();
    return this;
  }

  async ensureFresh(now: Clock = realClock, fetchImpl: FetchLike = fetch): Promise<ChatGPTAuth> {
    return this.expired(now) ? this.refresh(fetchImpl) : this;
  }

  /** The header set Codex attaches to ChatGPT-backed requests. */
  headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.access_token}`,
      "User-Agent": "codex-audio/0.1 (reverse-engineered from codex-cli)",
      originator: "codex_cli_rs",
    };
    // Python: `if self.account_id:` — falsy check, so "" behaves like null.
    if (this.account_id) {
      h["ChatGPT-Account-Id"] = this.account_id;
    }
    return h;
  }
}

export function chatgptBaseUrl(): string {
  const raw = process.env.CODEX_CHATGPT_BASE_URL ?? DEFAULT_CHATGPT_BASE_URL;
  // Python: .rstrip("/") strips ALL trailing slashes, not just one.
  return raw.replace(/\/+$/, "");
}

function formatUtcTimestamp(d: Date): string {
  // Python: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}
