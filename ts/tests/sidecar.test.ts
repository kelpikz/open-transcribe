import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Event = Record<string, unknown>;

async function startSidecar() {
	const dir = mkdtempSync(join(tmpdir(), "open-transcribe-test-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "test-token" } }));
	let status = 200;
	let text = "Test transcript.";
	let uploads = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			await request.formData();
			uploads++;
			return Response.json({ text }, { status });
		},
	});
	const events: Event[] = [];
	const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/sidecar-worker.ts", import.meta.url)), "--data-dir", dir], {
		env: { ...process.env, CODEX_HOME: dir, CODEX_CHATGPT_BASE_URL: `http://127.0.0.1:${server.port}` },
		stdin: "pipe", stdout: "pipe", stderr: "pipe", ipc() {},
	});
	const reading = (async () => {
		let carry = "";
		for await (const bytes of child.stdout) {
			carry += Buffer.from(bytes).toString("utf8");
			const lines = carry.split("\n");
			carry = lines.pop()!;
			for (const line of lines) events.push(JSON.parse(line) as Event);
		}
	})();
	const waitFor = async (predicate: () => boolean) => {
		const deadline = Date.now() + 5000;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`Sidecar timed out: ${JSON.stringify(events)}`);
			await Bun.sleep(10);
		}
	};
	const command = (value: Event) => { child.stdin.write(`${JSON.stringify(value)}\n`); child.stdin.flush(); };
	const control = (value: { held?: boolean; scenario?: string; crash?: boolean }) => child.send(value);
	const close = async () => {
		child.stdin.end();
		try {
			await Promise.race([child.exited, Bun.sleep(1000)]);
			if (child.exitCode === null) child.kill();
			await child.exited;
			await reading;
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	};
	try {
		await waitFor(() => events.some((e) => e.ev === "state" && e.state === "idle"));
		command({ cmd: "setAfterSpeak", value: "copy" });
		await waitFor(() => events.some((e) => e.ev === "settings" && e.afterSpeak === "copy"));
	} catch (error) {
		await close();
		throw error;
	}
	return {
		dir, events, waitFor, command, control, close,
		setResponse(code: number, value = "Test transcript.") { status = code; text = value; },
		get uploads() { return uploads; },
		async clip(scenario = "normal") {
			events.length = 0;
			control({ held: true, scenario });
			await waitFor(() => events.some((e) => e.ev === "state" && e.state === "recording"));
			await Bun.sleep(330);
			control({ held: false });
			await waitFor(() => events.some((e) => e.ev === "state" && e.state === "idle"));
		},
	};
}

test("desktop dictation succeeds, persists settings and supports copying the last text", async () => {
	const app = await startSidecar();
	try {
		await app.clip();
		expect(app.uploads).toBe(1);
		expect(app.events.some((e) => e.ev === "last" && e.delivery === "copied")).toBe(true);
		expect(app.events.some((e) => e.ev === "error")).toBe(false);
		expect(JSON.parse(readFileSync(join(app.dir, "settings.json"), "utf8")).afterSpeak).toBe("copy");
		app.command({ cmd: "copyLast" });
		await app.waitFor(() => app.events.some((e) => e.ev === "copied"));
	} finally { await app.close(); }
}, 10000);

test("an upload failure has a bubble message, returns to idle and allows a retry", async () => {
	const app = await startSidecar();
	try {
		app.setResponse(500);
		await app.clip();
		const error = app.events.find((e) => e.ev === "error");
		expect(error?.bubble).toBe("Transcription failed. Try again.");
		expect(String(error?.message)).toContain("500");
		expect(app.events.some((e) => e.ev === "last" && e.at)).toBe(false);
		app.setResponse(200);
		await app.clip();
		expect(app.events.some((e) => e.ev === "last" && e.delivery === "copied")).toBe(true);
	} finally { await app.close(); }
}, 10000);

test("a rejected sign-in has an actionable bubble message", async () => {
	const app = await startSidecar();
	try {
		app.setResponse(401);
		await app.clip();
		expect(app.events.some((e) => e.bubble === "Sign-in failed. Check settings.")).toBe(true);
		expect(app.events.some((e) => e.ev === "account" && e.signedIn === false)).toBe(true);
	} finally { await app.close(); }
}, 10000);

test("silent audio and empty transcripts are no longer silently dismissed", async () => {
	const app = await startSidecar();
	try {
		await app.clip("silence");
		expect(app.uploads).toBe(0);
		expect(app.events.some((e) => e.bubble === "No speech heard. Try again.")).toBe(true);
		app.setResponse(200, "");
		await app.clip();
		expect(app.events.some((e) => e.bubble === "No text returned. Try again.")).toBe(true);
	} finally { await app.close(); }
}, 10000);

test("a microphone failure is reported rather than uploading a partial clip", async () => {
	const app = await startSidecar();
	try {
		app.events.length = 0;
		app.control({ held: true, scenario: "openFailure" });
		await app.waitFor(() => app.events.some((e) => e.state === "error" && e.code === "microphone"));
		app.control({ held: false });
		await Bun.sleep(40);
		app.events.length = 0;
		app.control({ held: true, scenario: "normal" });
		await app.waitFor(() => app.events.some((e) => e.state === "recording"));
		app.control({ crash: true });
		await app.waitFor(() => app.events.some((e) => e.state === "error" && e.message === "test microphone disconnected"));
		expect(app.uploads).toBe(0);
	} finally { await app.close(); }
}, 10000);

test("an insertion failure retains the transcript for Copy it again", async () => {
	const app = await startSidecar();
	try {
		await app.clip("copyFailure");
		expect(app.events.some((e) => e.bubble === "Couldn't insert text. Open settings to copy it.")).toBe(true);
		expect(app.events.some((e) => e.ev === "last" && e.delivery === "failed")).toBe(true);
		app.control({ scenario: "normal" });
		app.command({ cmd: "copyLast" });
		await app.waitFor(() => app.events.some((e) => e.ev === "copied"));
		expect(app.events.some((e) => e.ev === "testClipboard" && e.text === "Test transcript.")).toBe(true);
	} finally { await app.close(); }
}, 10000);
