import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STARTUP_BUDGET, summarizeStartup, startupBudgetFailures } from "../../app/scripts/startup-metrics.js";

type Event = { ev?: string; state?: string; message?: string; startup?: {
	firstAudioMs: number; nativeOpens: number; hasFirstAudio: boolean;
} };

async function measureStartup(samples: number, extraDelayMs = 0, forceFallback = false) {
	const temporaryRoot = resolve(tmpdir());
	const directory = mkdtempSync(join(temporaryRoot, "open-transcribe-startup-"));
	if (dirname(directory) !== temporaryRoot) throw new Error("Unexpected startup test directory");
	const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/startup-worker.ts", import.meta.url)), "--data-dir", directory], {
		env: {
			...process.env, CODEX_HOME: directory,
			OPEN_TRANSCRIBE_STARTUP_EXTRA_DELAY_MS: String(extraDelayMs),
			OPEN_TRANSCRIBE_STARTUP_FORCE_FALLBACK: forceFallback ? "1" : "0",
		},
		stdin: "pipe", stdout: "pipe", stderr: "pipe", ipc() {},
	});
	const events: Event[] = [];
	const stderr = new Response(child.stderr).text();
	const reading = (async () => {
		let carry = "";
		for await (const bytes of child.stdout) {
			carry += Buffer.from(bytes).toString("utf8");
			const lines = carry.split("\n");
			carry = lines.pop()!;
			for (const line of lines) events.push(JSON.parse(line) as Event);
		}
	})();
	const waitForState = async (state: string) => {
		const deadline = performance.now() + 5000;
		while (!events.some(event => event.ev === "state" && event.state === state)) {
			const failure = events.find(event => event.ev === "error" || event.state === "error");
			if (failure) throw new Error(failure.message ?? JSON.stringify(failure));
			if (child.exitCode !== null) throw new Error(`Startup worker exited: ${await stderr}`);
			if (performance.now() > deadline) throw new Error(`Startup worker timed out: ${JSON.stringify(events)}`);
			await Bun.sleep(5);
		}
	};
	const measured: number[] = [];
	try {
		await waitForState("idle");
		for (let trial = 0; trial < samples; trial++) {
			events.length = 0;
			child.send({ held: true });
			await waitForState("recording");
			const sample = events.find(event => event.state === "recording")!.startup;
			if (!sample || !sample.hasFirstAudio || sample.nativeOpens !== trial + 1) {
				throw new Error("Recording must follow real native capture startup and the first controlled audio buffer.");
			}
			measured.push(sample.firstAudioMs);
			events.length = 0;
			child.send({ held: false });
			await waitForState("idle");
		}
		return measured;
	} finally {
		try {
			try { child.stdin.end(); } catch { child.kill(); }
			await Promise.race([child.exited, Bun.sleep(1000)]);
			if (child.exitCode === null) child.kill();
			await child.exited;
			await Promise.all([reading, stderr]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
}

test("startup summaries preserve the first press and use median and nearest-rank p90", () => {
	expect(summarizeStartup([100, 10, 20, 30])).toEqual({ firstMs: 100, medianMs: 25, p90Ms: 100, minMs: 10, maxMs: 100 });
	expect(() => summarizeStartup([])).toThrow();
	expect(() => summarizeStartup([Number.NaN])).toThrow();
});

const requiresWindows = process.platform !== "win32" || process.arch !== "x64";

test.skipIf(requiresWindows)("desktop hotkey startup stays within its software latency budget", async () => {
	const samples = await measureStartup(STARTUP_BUDGET.sampleCount);
	const failures = startupBudgetFailures(samples);
	const report = {
		schemaVersion: 1,
		measurement: "Desktop hotkey received to recording state, using an in-memory WinMM driver",
		bunVersion: Bun.version,
		platform: process.platform,
		budget: STARTUP_BUDGET,
		samplesMs: samples,
		firstAudio: summarizeStartup(samples),
		softwareOverhead: summarizeStartup(samples.map(ms => Math.max(0, ms - STARTUP_BUDGET.controlledAudioDelayMs))),
		failures,
	};
	if (process.env.OPEN_TRANSCRIBE_STARTUP_REPORT) {
		await Bun.write(process.env.OPEN_TRANSCRIBE_STARTUP_REPORT, `${JSON.stringify(report, null, 2)}\n`);
	}
	console.log(`Desktop startup overhead: ${JSON.stringify(report.softwareOverhead)}`);
	expect(failures, failures.join("\n")).toEqual([]);
}, 30000);

test.skipIf(requiresWindows)("the startup budget detects an added recorder delay", async () => {
	const samples = await measureStartup(3, 250);
	expect(startupBudgetFailures(samples).some(failure => failure.startsWith("Median"))).toBe(true);
}, 15000);

test.skipIf(requiresWindows)("the startup gate rejects an ffmpeg fallback on a supported native input", async () => {
	await expect(measureStartup(1, 0, true)).rejects.toThrow("tried to launch ffmpeg");
}, 10000);
