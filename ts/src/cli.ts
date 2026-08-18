#!/usr/bin/env bun
/**
 * codex-audio — speak, get text. Uses your ChatGPT subscription via Codex's login.
 */

import { listDevices, recordMicrophone } from "./audio.js";
import { Renderer } from "./renderer.js";
import {
	DEFAULT_LANGUAGE,
	DEFAULT_MODEL,
	TRANSCRIBE_MODELS,
	transcribeAudio,
	transcribeFile,
} from "./transcribe.js";

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
  --model MODEL         compatibility option; desktop endpoint chooses the model
                        (default: ${DEFAULT_MODEL}; known: ${TRANSCRIBE_MODELS.join(", ")})
  --list-devices        list audio input devices and exit
  --language, -l LANGUAGE
                        ISO-639-1 language hint (default: ${DEFAULT_LANGUAGE}). Use 'auto'
                        to let the model detect it per segment
  --prompt PROMPT       context hint to bias spelling of names/jargon
  --stream              compatibility option; upload transcription returns one
                        final transcript
  --silence-ms SILENCE_MS
                        compatibility option; upload transcription is not streamed
  --noise-reduction {near_field,far_field,none}
                        compatibility option; noise reduction is selected by the
                        desktop service
  --json                emit JSON instead of plain text
  --quiet, -q           no progress output on stderr
  --no-partials         show only settled segments, not live guesses
  --no-color            disable ANSI colour
  --raw-events          compatibility option; upload has no protocol events
  --session SESSION     compatibility option; upload has no session JSON
  --drain DRAIN         compatibility option; upload has no in-flight drain
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
		drain: 2.0,
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

		// Split --opt=value before matching, as argparse does.
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

	if (args.stream) {
		err(
			"--stream is unavailable: the Codex Desktop upload route returns one final transcript.",
		);
		return 2;
	}

	let text: string;
	try {
		text = await withInterrupt(args.input ? fileMain(args) : micMain(args));
	} catch (error) {
		if (error instanceof Interrupted) return 130;
		const e = error as Error;
		err(`error: ${e.name}: ${e.message}`);
		return 1;
	}

	process.stdout.write(
		args.json ? `${JSON.stringify({ text })}\n` : `${text}\n`,
	);
	return 0;
}

/** Ctrl-C during the run: the Python let KeyboardInterrupt reach `main`. */
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
	process.exitCode = await main();
}
