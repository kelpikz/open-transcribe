import { expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { AuthError, ChatGPTAuth } from "../src/codex/auth.ts";
import { checkFfmpeg, checkMicrophone, checkSignIn } from "../src/diagnostics.ts";

const run = (result: object) => (() => result) as unknown as typeof spawnSync;

test("ffmpeg: shows the version, or says that it is missing", () => {
	const found = checkFfmpeg(run({ stdout: "ffmpeg version 7.1-full_build Copyright ..." }));
	expect(found).toMatchObject({ status: "pass", detail: "Version 7.1-full_build" });
	const missing = checkFfmpeg(run({ error: new Error("ENOENT") }));
	expect(missing).toMatchObject({ status: "fail", title: "ffmpeg is missing" });
});

test("sign-in: missing credentials fail, a network problem only warns", async () => {
	const signedOut = await checkSignIn(() => {
		throw new AuthError("No Codex credentials.");
	});
	expect(signedOut).toMatchObject({ status: "fail", detail: "No Codex credentials." });

	const offline = new ChatGPTAuth({ accessToken: "x" });
	offline.ensureFresh = () => Promise.reject(new Error("fetch failed"));
	expect(await checkSignIn(() => offline)).toMatchObject({ status: "warn", title: "Could not reach ChatGPT" });

	const ok = new ChatGPTAuth({ accessToken: "x" });
	expect(await checkSignIn(() => ok)).toMatchObject({ status: "pass" });
});

test("microphone: none, not connected, and found", () => {
	expect(checkMicrophone([], null).status).toBe("fail");
	expect(checkMicrophone(["Mic A"], "Mic B")).toMatchObject({ status: "fail", title: "The microphone is not connected" });
	expect(checkMicrophone(["Mic A"], "Mic A")).toMatchObject({ status: "pass", detail: "Mic A" });
});
