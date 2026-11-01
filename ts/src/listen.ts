/**
 * `--listen`: push-to-talk dictation into the focused window (Windows).
 *
 * Hold the hotkey and speak. On release, the clip goes to the upload route,
 * and the text is pasted into the foreground window. When the foreground is
 * the desktop or the taskbar, or no window, the text goes to the clipboard
 * only and a short notice shows.
 */

import {
	LiveMicrophone,
	RECORD_CHANNELS,
	RECORD_SAMPLE_RATE,
	pcmDurationMs,
	pcmPeak,
	wavFromPcm,
} from "./audio/index.js";
import { transcribeAudio } from "./codex/index.js";
import * as desktop from "./desktop/win32.js";

export const DEFAULT_HOTKEY = "ctrl+shift+space";

/** How often the key state is read. */
const POLL_MS = 15;
/** A shorter hold is a slip of the finger, not speech. */
export const MIN_CLIP_MS = 300;
/**
 * A clip whose loudest sample is below this is silence. The model invents
 * text for silence, so such a clip is not sent.
 */
export const SILENT_PEAK = 500;
/** Time for the target app to read the clipboard before it is restored. */
const PASTE_SETTLE_MS = 500;

// ---------------------------------------------------------------------------
// Hotkey
// ---------------------------------------------------------------------------

export interface Hotkey {
	label: string;
	/** Each entry is one key; any one of its virtual-key codes counts. */
	keys: number[][];
	usesWin: boolean;
}

const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

const NAMED_KEYS: Record<string, number[]> = {
	ctrl: [0x11],
	control: [0x11],
	lctrl: [0xa2],
	rctrl: [0xa3],
	shift: [0x10],
	lshift: [0xa0],
	rshift: [0xa1],
	alt: [0x12],
	lalt: [0xa4],
	ralt: [0xa5],
	win: [VK_LWIN, VK_RWIN],
	lwin: [VK_LWIN],
	rwin: [VK_RWIN],
	space: [0x20],
	tab: [0x09],
	capslock: [0x14],
	insert: [0x2d],
	pause: [0x13],
	scrolllock: [0x91],
};

function keyCodes(name: string): number[] | undefined {
	const named = NAMED_KEYS[name];
	if (named) return named;
	if (/^[a-z0-9]$/.test(name)) return [name.toUpperCase().charCodeAt(0)];
	const fkey = /^f([1-9]|1\d|2[0-4])$/.exec(name);
	if (fkey?.[1]) return [0x6f + Number(fkey[1])];
	return undefined;
}

/** Parse a hotkey such as "ctrl+win", "ctrl+shift+space" or "f9". */
export function parseHotkey(spec: string): Hotkey {
	const names = spec
		.toLowerCase()
		.split("+")
		.map((name) => name.trim());
	if (names.some((name) => name === "")) {
		throw new Error(`invalid hotkey '${spec}'`);
	}
	const keys = names.map((name) => {
		const codes = keyCodes(name);
		if (!codes) throw new Error(`unknown key '${name}' in hotkey '${spec}'`);
		return codes;
	});
	const usesWin = keys.some((codes) => codes.includes(VK_LWIN) || codes.includes(VK_RWIN));
	return { label: names.join("+"), keys, usesWin };
}

export function allDown(hotkey: Hotkey): boolean {
	return hotkey.keys.every((codes) => codes.some(desktop.isKeyDown));
}

function anyDown(hotkey: Hotkey): boolean {
	return hotkey.keys.some((codes) => codes.some(desktop.isKeyDown));
}

/** Wait until no key of the hotkey is down. False after `timeoutMs`. */
async function waitReleased(hotkey: Hotkey, timeoutMs = 3000): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (anyDown(hotkey)) {
		if (Date.now() > end) return false;
		await Bun.sleep(POLL_MS);
	}
	return true;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type Delivery =
	| { kind: "pasted"; title: string }
	| { kind: "copied"; reason: string };

/**
 * Paste the text into the foreground window, then put the old clipboard
 * content back. With no window to paste into, copy the text only.
 */
export async function deliver(
	text: string,
	hotkey: Hotkey,
	/** The window that had focus when the recording ended. */
	expected?: desktop.ForegroundWindow,
): Promise<Delivery> {
	const target = desktop.foregroundWindow();
	// A key of the hotkey that is still down would change Ctrl+V into
	// another shortcut (Win+V opens clipboard history).
	const reason = !target.canPaste
		? "no window to paste into"
		: expected && expected.hwnd !== target.hwnd
			? "the focus moved to another window"
			: !(await waitReleased(hotkey))
			? "the hotkey is still held"
			: null;
	if (reason !== null) {
		await desktop.setClipboardText(text);
		desktop.notify("codex-audio", `Copied to the clipboard (${reason}).`);
		return { kind: "copied", reason };
	}

	const saved = await desktop.readClipboard();
	await desktop.setClipboardText(text, { temporary: true });
	const sequence = desktop.clipboardSequence();
	desktop.sendCtrlV();
	await Bun.sleep(PASTE_SETTLE_MS);
	// If something else changed the clipboard in the meantime, keep that.
	if (desktop.clipboardSequence() === sequence) {
		await desktop.writeClipboard(saved);
	}
	return { kind: "pasted", title: target.title || target.className };
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface ListenOptions {
	/** ffmpeg input arguments for the microphone. */
	inputArgs: string[];
	hotkey: Hotkey;
	/** ISO-639-1 hint, or null to let the service detect it. */
	language: string | null;
	log: (message: string) => void;
	/** Called after each clip, with the text and where it went. */
	onText?: (text: string, delivery: Delivery) => void;
}

async function handleClip(
	pcm: Buffer,
	heldMs: number,
	target: desktop.ForegroundWindow,
	options: ListenOptions,
): Promise<void> {
	const { log } = options;
	// The clip also holds the pre-roll, so check the hold time, not the clip length.
	if (heldMs < MIN_CLIP_MS) {
		log(`skipped: the key was held for only ${Math.round(heldMs)} ms`);
		return;
	}
	const ms = pcmDurationMs(pcm);
	if (pcmPeak(pcm) < SILENT_PEAK) {
		log("skipped: no speech was heard");
		return;
	}
	log(`transcribing ${(ms / 1000).toFixed(1)} s…`);
	const text = (
		await transcribeAudio(wavFromPcm(pcm, RECORD_SAMPLE_RATE, RECORD_CHANNELS), {
			filename: "codex-audio.wav",
			contentType: "audio/wav",
			language: options.language,
		})
	).trim();
	if (text === "") {
		log("skipped: the transcript is empty");
		return;
	}
	const delivery = await deliver(text, options.hotkey, target);
	log(
		delivery.kind === "pasted"
			? `pasted into "${delivery.title}": ${text}`
			: `copied to the clipboard (${delivery.reason}): ${text}`,
	);
	options.onText?.(text, delivery);
}

/**
 * Run until the microphone stops (or the process is interrupted). Clips are
 * handled one at a time, in the order they were recorded.
 */
export async function listen(options: ListenOptions): Promise<never> {
	const { hotkey, log } = options;
	desktop.foregroundWindow(); // Load the Windows libraries now, not on the first key press.
	const mic = await LiveMicrophone.open(options.inputArgs);
	// On Windows, a child process lives on after its parent exits.
	process.once("exit", () => mic.stop());

	log(`Ready. Hold ${hotkey.label} and speak; release to insert the text. Ctrl+C quits.`);

	let held = false;
	let heldSince = 0;
	let queue = Promise.resolve();
	const timer = setInterval(() => {
		const down = allDown(hotkey);
		if (down && !held) {
			held = true;
			heldSince = Date.now();
			if (hotkey.usesWin) desktop.maskStartMenu();
			mic.begin();
			log("recording…");
		} else if (!down && held) {
			held = false;
			const pcm = mic.end();
			const heldMs = Date.now() - heldSince;
			const target = desktop.foregroundWindow();
			queue = queue
				.then(() => handleClip(pcm, heldMs, target, options))
				.catch((error: Error) => log(`error: ${error.message}`));
		}
	}, POLL_MS);

	try {
		await mic.exited;
	} finally {
		clearInterval(timer);
	}
	throw new Error(mic.failureMessage() ?? "the microphone stopped");
}
