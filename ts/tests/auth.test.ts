import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError, ChatGPTAuth } from "../src/codex/auth.ts";

/** A JWT that expires `seconds` from now. Only the `exp` claim matters. */
function jwt(seconds: number): string {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part({ exp: Math.floor(Date.now() / 1000) + seconds })}.sig`;
}

let home: string;
const realFetch = globalThis.fetch;
let calls: string[];

function writeAuth(access: string, refresh: string): void {
	const tokens = { access_token: access, refresh_token: refresh, account_id: "acct" };
	writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens }));
}

function readAuth() {
	return JSON.parse(readFileSync(join(home, "auth.json"), "utf-8"));
}

/** The token server accepts only `valid` and returns `next` tokens. */
function tokenServer(valid: string, next: { access: string; refresh: string }) {
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		const sent = JSON.parse(String(init?.body)).refresh_token;
		calls.push(sent);
		if (sent !== valid) return new Response('{"error":"invalid_grant"}', { status: 400 });
		return Response.json({ access_token: next.access, refresh_token: next.refresh });
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auth-test-"));
	process.env.CODEX_HOME = home;
	calls = [];
});

afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.CODEX_HOME;
	rmSync(home, { recursive: true, force: true });
});

test("a refresh saves the new tokens and keeps the other keys", async () => {
	const fresh = jwt(3600);
	writeAuth(jwt(-10), "r1");
	tokenServer("r1", { access: fresh, refresh: "r2" });
	const auth = await ChatGPTAuth.load().ensureFresh();
	expect(auth.accessToken).toBe(fresh);
	const saved = readAuth();
	expect(saved.tokens.refresh_token).toBe("r2");
	expect(saved.tokens.account_id).toBe("acct");
	expect("OPENAI_API_KEY" in saved).toBe(true);
	expect(readdirSync(home)).toEqual(["auth.json"]); // No temporary file stays.
});

test("tokens that Codex refreshed before us are used without a request", async () => {
	writeAuth(jwt(-10), "r1");
	const auth = ChatGPTAuth.load();
	const codexToken = jwt(3600);
	writeAuth(codexToken, "r2"); // Codex refreshes.
	tokenServer("r2", { access: "unused", refresh: "unused" });
	await auth.ensureFresh();
	expect(auth.accessToken).toBe(codexToken);
	expect(calls).toEqual([]);
});

test("a rejected refresh uses the tokens that Codex saved in the meantime", async () => {
	writeAuth(jwt(-10), "r1");
	const auth = ChatGPTAuth.load();
	const codexToken = jwt(3600);
	globalThis.fetch = (async () => {
		calls.push("r1");
		writeAuth(codexToken, "r2"); // Codex refreshed while our request was in flight.
		return new Response('{"error":"invalid_grant"}', { status: 400 });
	}) as unknown as typeof fetch;
	await auth.ensureFresh();
	expect(auth.accessToken).toBe(codexToken);
	expect(auth.refreshToken).toBe("r2");
});

test("a rejected refresh with no newer tokens signs out", async () => {
	writeAuth(jwt(-10), "r1");
	tokenServer("other", { access: "unused", refresh: "unused" });
	await expect(ChatGPTAuth.load().ensureFresh()).rejects.toBeInstanceOf(AuthError);
	expect(calls).toEqual(["r1"]);
});

test("two refreshes at the same time send the refresh token only one time", async () => {
	const fresh = jwt(3600);
	writeAuth(jwt(-10), "r1");
	tokenServer("r1", { access: fresh, refresh: "r2" });
	const [a, b] = await Promise.all([ChatGPTAuth.load().ensureFresh(), ChatGPTAuth.load().ensureFresh()]);
	expect(calls).toEqual(["r1"]);
	expect(a.accessToken).toBe(fresh);
	expect(b.accessToken).toBe(fresh);
});
