/**
 * ChatGPT subscription auth, reused from the Codex CLI's credential store.
 *
 * Codex stores OAuth tokens in ~/.codex/auth.json:
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
 * We read the same file and mint the same headers Codex sends, so requests are
 * billed against the ChatGPT plan rather than a platform API key.
 *
 * Runtime-agnostic: standard APIs only, so this runs under Node/Electron as
 * well as Bun.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Same client_id the Codex CLI registers for its device/PKCE login. */
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function authPath(): string {
  return join(codexHome(), "auth.json");
}

/** Read the claims of a JWT without verifying it. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (payload === undefined) return null;
    const claims: unknown = JSON.parse(base64UrlDecode(payload));
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
    return claims as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read `exp` out of a JWT without verifying it (we only need the clock). */
export function jwtExp(token: string): number | null {
  const exp = jwtClaims(token)?.exp;
  const seconds = typeof exp === "number" ? exp : typeof exp === "string" ? Number(exp) : NaN;
  return Number.isFinite(seconds) ? seconds : null;
}

function base64UrlDecode(value: string): string {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The on-disk shape of auth.json. Unknown keys are preserved on save. */
interface AuthFile {
  tokens?: {
    access_token?: string | null;
    refresh_token?: string | null;
    account_id?: string | null;
    id_token?: string | null;
  } | null;
  [key: string]: unknown;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

/** The refresh in progress in this process, if there is one. */
let refreshing: Promise<unknown> | null = null;

export class AuthError extends Error {
  override readonly name = "AuthError";
}

export class ChatGPTAuth {
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
  idToken: string | null;

  constructor(fields: {
    accessToken: string;
    refreshToken?: string | null;
    accountId?: string | null;
    idToken?: string | null;
  }) {
    this.accessToken = fields.accessToken;
    this.refreshToken = fields.refreshToken ?? null;
    this.accountId = fields.accountId ?? null;
    this.idToken = fields.idToken ?? null;
  }

  static load(): ChatGPTAuth {
    const path = authPath();
    if (!existsSync(path)) {
      throw new AuthError(
        `No Codex credentials at ${path}.\n` +
          "Run `codex login` first. This tool reuses that session.",
      );
    }
    let raw: AuthFile;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8")) as AuthFile;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error();
    } catch {
      throw new AuthError(`Could not read Codex credentials at ${path}. Run \`codex login\` again.`);
    }
    const tokens = raw.tokens ?? {};
    const access = tokens.access_token;
    if (typeof access !== "string" || !access) {
      throw new AuthError(
        `${path} has no ChatGPT access_token (API-key-only login?).\n` +
          "Run `codex login` and choose 'Sign in with ChatGPT'.",
      );
    }
    return new ChatGPTAuth({
      accessToken: access,
      refreshToken: tokens.refresh_token,
      accountId: tokens.account_id,
      idToken: tokens.id_token,
    });
  }

  save(): void {
    const path = authPath();
    const raw: AuthFile = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf-8")) as AuthFile)
      : {};
    raw.tokens = {
      ...(raw.tokens ?? {}),
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      account_id: this.accountId,
      id_token: this.idToken,
    };
    raw.last_refresh = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    // Write a temporary file, then rename it. Then Codex never reads a
    // half-written file.
    const text = JSON.stringify(raw, null, 2);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, text, "utf-8");
      renameSync(tmp, path);
    } catch {
      // On Windows, the rename fails if another program has the file open.
      rmSync(tmp, { force: true });
      writeFileSync(path, text, "utf-8");
    }
  }

  /**
   * Take the tokens in auth.json if they are not the tokens we have. Codex
   * (or another copy of this app) can refresh them at any time, and each
   * refresh token works only one time.
   */
  private takeNewerTokens(): boolean {
    let disk: ChatGPTAuth;
    try {
      disk = ChatGPTAuth.load();
    } catch {
      return false;
    }
    if (disk.accessToken === this.accessToken && disk.refreshToken === this.refreshToken) {
      return false;
    }
    this.accessToken = disk.accessToken;
    this.refreshToken = disk.refreshToken;
    this.accountId = disk.accountId;
    this.idToken = disk.idToken;
    return true;
  }

  /** The email of the ChatGPT account, from the ID token. */
  get email(): string | null {
    const email = this.idToken ? jwtClaims(this.idToken)?.email : null;
    return typeof email === "string" ? email : null;
  }

  get expired(): boolean {
    const exp = jwtExp(this.accessToken);
    // Refresh a minute early rather than racing the boundary mid-session.
    return exp !== null && exp - 60 < Date.now() / 1000;
  }

  async refresh(): Promise<this> {
    // Two refreshes in this process must not send the same refresh token.
    if (refreshing) await refreshing.catch(() => {});
    const run = this.refreshOnce();
    refreshing = run;
    try {
      return await run;
    } finally {
      if (refreshing === run) refreshing = null;
    }
  }

  private async refreshOnce(): Promise<this> {
    // Another program can have refreshed the tokens already.
    if (this.takeNewerTokens() && !this.expired) return this;
    if (!this.refreshToken) {
      throw new AuthError("Access token expired and no refresh_token stored; run `codex login`.");
    }
    let response = await requestRefresh(this.refreshToken);
    // A rejected refresh token can mean that another program used it first.
    // Then auth.json has the new tokens. Sign out only if it does not.
    if (isRejected(response) && this.takeNewerTokens()) {
      if (!this.expired) return this;
      if (this.refreshToken) response = await requestRefresh(this.refreshToken);
    }
    if (!response.ok) {
      if (isRejected(response)) {
        throw new AuthError(`Your ChatGPT sign-in was rejected (${response.status}). Run \`codex login\` again.`);
      }
      throw new Error(`${response.status} from ${TOKEN_URL}: ${(await response.text()).slice(0, 500)}`);
    }
    const body = (await response.json()) as TokenResponse;
    this.accessToken = body.access_token;
    this.refreshToken = body.refresh_token ?? this.refreshToken;
    this.idToken = body.id_token ?? this.idToken;
    this.save();
    return this;
  }

  async ensureFresh(): Promise<this> {
    return this.expired ? await this.refresh() : this;
  }

  /** The header set Codex attaches to ChatGPT-backed requests. */
  headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "User-Agent": "open-transcribe/0.1 (reverse-engineered from codex-cli)",
      originator: "codex_cli_rs",
    };
    if (this.accountId) {
      headers["ChatGPT-Account-Id"] = this.accountId;
    }
    return headers;
  }

  /**
   * Headers used by Codex Desktop's `/transcribe` upload route.
   *
   * This route is separate from realtime conversation. The desktop app
   * identifies the upload as a Codex attachment and uses the desktop
   * originator, while authentication still comes from the Codex login.
   */
  transcriptionHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "User-Agent": "open-transcribe/0.1 (reverse-engineered from Codex Desktop)",
      "ChatGPT-Account-Id": this.accountId || "",
      originator: "Codex Desktop",
      "x-codex-base64": "1",
      "X-OpenAI-Attach-Auth": "1",
      "X-OpenAI-Attach-Desktop-Surface": "Codex Desktop",
      "X-OpenAI-Attach-Integrity-State": "1",
    };
    return Object.fromEntries(Object.entries(headers).filter(([, value]) => value));
  }
}

function requestRefresh(refreshToken: string): Promise<Response> {
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
    signal: AbortSignal.timeout(30_000),
  });
}

/** 400 (invalid_grant), 401 and 403 mean the refresh token is not valid. */
function isRejected(response: Response): boolean {
  return [400, 401, 403].includes(response.status);
}

export function chatgptBaseUrl(): string {
  const base = process.env.CODEX_CHATGPT_BASE_URL || DEFAULT_CHATGPT_BASE_URL;
  return base.replace(/\/+$/, "");
}
