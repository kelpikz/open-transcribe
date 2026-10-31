#!/usr/bin/env bun
/**
 * codex-audio — speak, get text. Uses your ChatGPT subscription via Codex's login.
 */

import { readFileSync } from "node:fs";

import {
	fileTrack,
	listDevices,
	microphoneTrack,
	recordMicrophone,
	waitForLine,
} from "./audio/index.js";
import {
	ChatGPTAuth,
	DEFAULT_LANGUAGE,
	DEFAULT_MODEL,
	RealtimeTranscriber,
	TRANSCRIBE_MODELS,
	realtime,
	transcribeAudio,
	transcribeFile,
} from "./codex/index.js";
import { Renderer } from "./renderer.js";

const PROG = "codex-audio";

function err(message: string): void {
	process.stderr.write(`${message}\n`);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderFinal(text: string, args: Args): void {
	if (args.quiet) return;
	const renderer = new Renderer(
		true,
		false,
		Boolean(process.stderr.isTTY) && !args.noColor,
	);
	renderer.final(text);
	renderer.done();
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const NOISE_REDUCTION_CHOICES = ["near_field", "far_field", "none"] as const;

export interface Args {
	input: string | null;
	device: string | number | null;
	model: string;
	listDevices: boolean;
	language: string;
	prompt: string | null;
	stream: boolean;
	silenceMs: number;
	noiseReduction: (typeof NOISE_REDUCTION_CHOICES)[number];
	json: boolean;
	quiet: boolean;
	noPartials: boolean;
	noColor: boolean;
	rawEvents: boolean;
	session: string | null;
	drain: number;
}

/** Thrown for a usage error; `main` turns it into exit code 2. */
export class UsageError extends Error {
	override readonly name = "UsageError";
}

const HELP = `usage: ${PROG} [-h] [--device DEVICE] [--model MODEL] [--list-devices]
                   [--language LANGUAGE] [--prompt PROMPT] [--stream]
                   [--silence-ms SILENCE_MS]
                   [--noise-reduction {near_field,far_field,none}] [--json]
                   [--quiet] [--no-partials] [--no-color] [--raw-events]
                   [--session SESSION] [--drain DRAIN]
                   [input]

Speech to text using your ChatGPT subscription (via \`codex login\`).

positional arguments:
  input                 audio file to transcribe; omit to use the microphone

options:
  -h, --help            show this help message and exit
  --device DEVICE       input device index or name (see --list-devices)
  --model MODEL         --stream only; the upload endpoint chooses its own model
                        (default: ${DEFAULT_MODEL}; known: ${TRANSCRIBE_MODELS.join(", ")})
  --list-devices        list audio input devices and exit
  --language, -l LANGUAGE
                        ISO-639-1 language hint (default: ${DEFAULT_LANGUAGE}). Use 'auto'
                        to let the model detect it per segment
  --prompt PROMPT       --stream only; context hint to bias spelling of names/jargon
  --stream              stream over WebRTC and show text while you speak
  --silence-ms SILENCE_MS
                        --stream only; silence that ends a segment (default: 500)
  --noise-reduction {near_field,far_field,none}
                        --stream only; input noise reduction (default: none)
  --json                emit JSON instead of plain text
  --quiet, -q           no progress output on stderr
  --no-partials         show only settled segments, not live guesses
  --no-color            disable ANSI colour
  --raw-events          --stream only; print every server event as JSON on stderr
  --session SESSION     --stream only; JSON file that replaces the session payload
  --drain DRAIN         --stream only; seconds to wait for the last transcripts
                        after the audio ends (default: 10)
`;

/** Sentinel thrown by `--help`, so `main` can print and exit 0. */
class HelpRequested extends Error {}

export function parseArgs(argv: string[]): Args {
	const args: Args = {
		input: null,
		device: null,
		model: DEFAULT_MODEL,
		listDevices: false,
		language: DEFAULT_LANGUAGE,
		prompt: null,
		stream: false,
		silenceMs: 500,
		noiseReduction: "none",
		json: false,
		quiet: false,
		noPartials: false,
		noColor: false,
		rawEvents: false,
		session: null,
		drain: 10,
	};

	const flags: Record<string, keyof Args> = {
		"--list-devices": "listDevices",
		"--stream": "stream",
		"--json": "json",
		"--quiet": "quiet",
		"-q": "quiet",
		"--no-partials": "noPartials",
		"--no-color": "noColor",
		"--raw-events": "rawEvents",
	};
	const valued = new Set([
		"--device",
		"--model",
		"--language",
		"-l",
		"--prompt",
		"--silence-ms",
		"--noise-reduction",
		"--session",
		"--drain",
	]);

	let positional: string | null = null;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === undefined) continue;

		if (token === "-h" || token === "--help") throw new HelpRequested();

		// Split --opt=value before matching, so both spellings work.
		let name = token;
		let inlineValue: string | null = null;
		const equals = token.indexOf("=");
		if (token.startsWith("--") && equals !== -1) {
			name = token.slice(0, equals);
			inlineValue = token.slice(equals + 1);
		}

		const flag = flags[name];
		if (flag !== undefined && inlineValue === null) {
			(args[flag] as boolean) = true;
			continue;
		}

		if (valued.has(name)) {
			const value = inlineValue ?? argv[++i];
			if (value === undefined) {
				throw new UsageError(`argument ${name}: expected one argument`);
			}
			applyValue(args, name, value);
			continue;
		}

		if (token.startsWith("-") && token !== "-") {
			throw new UsageError(`unrecognized arguments: ${token}`);
		}

		if (positional !== null) {
			throw new UsageError(`unrecognized arguments: ${token}`);
		}
		positional = token;
	}

	args.input = positional;
	return args;
}

function applyValue(args: Args, name: string, value: string): void {
	switch (name) {
		case "--device":
			args.device = value;
			return;
		case "--model":
			args.model = value;
			return;
		case "--language":
		case "-l":
			args.language = value;
			return;
		case "--prompt":
			args.prompt = value;
			return;
		case "--session":
			args.session = value;
			return;
		case "--silence-ms":
			args.silenceMs = parseIntStrict(name, value);
			return;
		case "--drain":
			args.drain = parseFloatStrict(name, value);
			return;
		case "--noise-reduction": {
			const choice = NOISE_REDUCTION_CHOICES.find((option) => option === value);
			if (choice === undefined) {
				const options = NOISE_REDUCTION_CHOICES.map(
					(option) => `'${option}'`,
				).join(", ");
				throw new UsageError(
					`argument --noise-reduction: invalid choice: '${value}' (choose from ${options})`,
				);
			}
			args.noiseReduction = choice;
			return;
		}
		default:
			throw new UsageError(`unrecognized arguments: ${name}`);
	}
}

function parseIntStrict(name: string, value: string): number {
	if (!/^[+-]?\d+$/.test(value.trim())) {
		throw new UsageError(`argument ${name}: invalid int value: '${value}'`);
	}
	return Number(value.trim());
}

function parseFloatStrict(name: string, value: string): number {
	const trimmed = value.trim();
	if (trimmed === "" || !Number.isFinite(Number(trimmed))) {
		throw new UsageError(`argument ${name}: invalid float value: '${value}'`);
	}
	return Number(trimmed);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function micMain(args: Args): Promise<string> {
	if (!args.quiet) err("Opening the microphone…");
	const data = await recordMicrophone(args.device, {
		// Only invite speech once the device actually delivers samples.
		onReady: () => {
			if (!args.quiet) err("Recording — press Enter to stop.");
		},
	});
	if (!args.quiet) err("transcribing…");
	const text = await transcribeAudio(data, {
		filename: "codex-audio.wav",
		contentType: "audio/wav",
		language: args.language === "auto" ? null : args.language,
	});
	renderFinal(text, args);
	return text;
}

async function fileMain(args: Args): Promise<string> {
	if (!args.quiet) err("transcribing…");
	const text = await transcribeFile(args.input as string, {
		language: args.language === "auto" ? null : args.language,
	});
	renderFinal(text, args);
	return text;
}

/** Time for the last RTP packets to reach the server after ffmpeg stops. */
const TAIL_MS = 1000;

function streamSession(args: Args): realtime.SessionPayload {
	if (args.session) {
		return JSON.parse(
			readFileSync(args.session, "utf-8"),
		) as realtime.SessionPayload;
	}
	return realtime.buildSession({
		model: args.model,
		language: args.language === "auto" ? null : args.language,
		prompt: args.prompt,
		silenceMs: args.silenceMs,
		noiseReduction: args.noiseReduction === "none" ? null : args.noiseReduction,
		// Server VAD cuts the audio into segments and sends each transcript as
		// soon as the speaker pauses. Without it nothing arrives until the end.
		vad: true,
	});
}

async function streamMain(args: Args): Promise<string> {
	const tty = Boolean(process.stderr.isTTY);
	const renderer = new Renderer(
		!args.quiet,
		tty && !args.noPartials,
		tty && !args.noColor,
	);
	const session = streamSession(args);
	const auth = await ChatGPTAuth.load();
	await auth.ensureFresh();

	const rt = new RealtimeTranscriber(auth, session, {
		onDelta: (delta) => renderer.delta(delta),
		onFinal: (text) => renderer.final(text),
		onEvent: args.rawEvents
			? (event) => err(JSON.stringify(event))
			: undefined,
	});
	const source = args.input
		? await fileTrack(args.input)
		: await microphoneTrack(args.device ?? undefined);
	let finished = false;

	try {
		renderer.status("connecting…");
		await rt.connect(source.track);
		await rt.waitUntilOpen();

		// Start the audio only now. Audio sent before the channel opens is lost.
		const ffmpeg = source.play();
		if (args.input) {
			renderer.status("streaming…");
			await ffmpeg.exited;
		} else {
			renderer.status("Opening the microphone…");
			await Promise.race([source.ready, ffmpeg.exited]);
			renderer.status("Recording — press Enter to stop.");
			await Promise.race([waitForLine(), ffmpeg.exited]);
			ffmpeg.stop();
			await ffmpeg.exited;
		}

		const failure = ffmpeg.failureMessage();
		if (failure !== null && rt.transcript.text === "") {
			throw new Error(failure);
		}

		await Bun.sleep(TAIL_MS);
		finished = await rt.finish(args.drain * 1000);
	} finally {
		source.stop();
		await rt.close();
	}

	const text = rt.transcript.text;
	renderer.done();
	if (!finished) {
		throw new IncompleteStream(
			`the last transcript did not arrive within ${args.drain} s; try a larger --drain`,
			text,
		);
	}
	if (rt.lastError !== null) {
		throw new IncompleteStream(
			`realtime error: ${JSON.stringify(rt.lastError)}`,
			text,
		);
	}
	return text;
}

/** The stream failed, but `text` holds the transcript received before. */
class IncompleteStream extends Error {
	override readonly name = "IncompleteStream";
	constructor(
		message: string,
		readonly text: string,
	) {
		super(message);
	}
}

function writeText(text: string, args: Args): void {
	process.stdout.write(
		args.json ? `${JSON.stringify({ text })}\n` : `${text}\n`,
	);
}

export async function main(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		if (error instanceof HelpRequested) {
			process.stdout.write(HELP);
			return 0;
		}
		err(`usage: ${PROG} [-h] ... [input]`);
		err(`${PROG}: error: ${(error as Error).message}`);
		return 2;
	}

	if (args.listDevices) {
		process.stdout.write(`${listDevices()}\n`);
		return 0;
	}

	if (typeof args.device === "string" && /^\d+$/.test(args.device)) {
		args.device = Number(args.device);
	}

	let text: string;
	try {
		const run = args.stream
			? streamMain(args)
			: args.input
				? fileMain(args)
				: micMain(args);
		text = await withInterrupt(run);
	} catch (error) {
		if (error instanceof Interrupted) return 130;
		// Keep the text that did arrive, but still report the failure.
		if (error instanceof IncompleteStream && error.text !== "") {
			writeText(error.text, args);
		}
		const e = error as Error;
		err(`error: ${e.name}: ${e.message}`);
		return 1;
	}

	writeText(text, args);
	return 0;
}

/** Ctrl-C during the run; `main` turns it into exit code 130. */
class Interrupted extends Error {}

async function withInterrupt<T>(work: Promise<T>): Promise<T> {
	let onSigint: (() => void) | null = null;
	const interrupted = new Promise<never>((_, reject) => {
		onSigint = () => reject(new Interrupted());
		process.once("SIGINT", onSigint);
	});
	try {
		return await Promise.race([work, interrupted]);
	} finally {
		if (onSigint) process.off("SIGINT", onSigint);
	}
}

if (import.meta.main) {
	// werift leaves sockets and timers open after the peer closes, so the
	// event loop never empties on its own after --stream. Exit explicitly.
	process.exit(await main());
}
