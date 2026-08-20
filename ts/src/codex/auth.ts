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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** Read `exp` out of a JWT without verifying it (we only need the clock). */
export function jwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (payload === undefined) return null;
    const claims: unknown = JSON.parse(base64UrlDecode(payload));
    if (typeof claims !== "object" || claims === null) return null;
    const exp = (claims as Record<string, unknown>).exp;
    const seconds = typeof exp === "number" ? exp : typeof exp === "string" ? Number(exp) : NaN;
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
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
      throw new Error(
        `No Codex credentials at ${path}.\n` +
          "Run `codex login` first — this tool reuses that session.",
      );
    }
    const raw = JSON.parse(readFileSync(path, "utf-8")) as AuthFile;
    const tokens = raw.tokens ?? {};
    const access = tokens.access_token;
    if (!access) {
      throw new Error(
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
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf-8");
  }

  get expired(): boolean {
    const exp = jwtExp(this.accessToken);
    // Refresh a minute early rather than racing the boundary mid-session.
    return exp !== null && exp - 60 < Date.now() / 1000;
  }

  async refresh(): Promise<this> {
    if (!this.refreshToken) {
      throw new Error("Access token expired and no refresh_token stored; run `codex login`.");
    }
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
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
      "User-Agent": "codex-audio/0.1 (reverse-engineered from codex-cli)",
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
      "User-Agent": "codex-audio/0.1 (reverse-engineered from Codex Desktop)",
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

export function chatgptBaseUrl(): string {
  const base = process.env.CODEX_CHATGPT_BASE_URL || DEFAULT_CHATGPT_BASE_URL;
  return base.replace(/\/+$/, "");
}
