/**
 * The background process of the desktop app (Windows).
 *
 * The Tauri app starts this file as a sidecar. It watches the shortcut. Hold
 * the shortcut to record a clip: the microphone opens, and it closes again on
 * release. Then the clip is sent and the text is pasted into the focused
 * window. Only the last text is kept, in memory, so it can be copied again.
 *
 * Protocol: one JSON object for each line.
 *   stdin  (commands): {cmd: "getState" | "setHotkey" | "pauseHotkey" | "setLanguage"
 *                       | "setMicrophone" | "listDevices" | "setAfterSpeak" | "setSounds"
 *                       | "copyLast" | "checkAccount", ...}
 *   stdout (events):   {ev: "state" | "level" | "settings" | "devices" | "account"
 *                       | "last" | "copied" | "error", ...}
 *
 * Usage: codex-audio-sidecar --data-dir DIR
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
	LiveMicrophone,
	RECORD_CHANNELS,
	RECORD_SAMPLE_RATE,
	audioDeviceNames,
	micInputArgs,
	pcmPeak,
	wavFromPcm,
} from "./audio/index.js";
import { AuthError, ChatGPTAuth, TranscriptionError, transcribeAudio } from "./codex/index.js";
import * as desktop from "./desktop/win32.js";
import {
	DEFAULT_HOTKEY,
	MIN_CLIP_MS,
	SILENT_PEAK,
	allDown,
	deliver,
	parseHotkey,
	type Hotkey,
} from "./listen.js";

const POLL_MS = 15;
const LEVEL_MS = 60;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type AfterSpeak = "paste" | "copy";

interface Settings {
	hotkey: string;
	/** ISO-639-1 code, or "auto". */
	language: string;
	/** The name of the input device, or null for the default device. */
	microphone: string | null;
	/** "paste": paste into the focused field. "copy": put on the clipboard only. */
	afterSpeak: AfterSpeak;
	/** Play a short tone when a recording starts and stops. */
	sounds: boolean;
}

function argValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const dataDir = argValue("--data-dir") ?? join(process.cwd(), ".codex-audio");
mkdirSync(dataDir, { recursive: true });
const settingsPath = join(dataDir, "settings.json");

/** Keep a bad file beside the original, so the next write does not destroy it. */
function keepBadFile(path: string): void {
	try {
		copyFileSync(path, `${path}.bad-${Date.now()}`);
	} catch {
		// Nothing to keep.
	}
}

/** The parsed file, or undefined if it is missing or is not valid JSON. */
function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		keepBadFile(path);
		return undefined;
	}
}

/** Write to a temporary file first, so a crash never leaves half a file. */
function writeJson(path: string, value: unknown): void {
	writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
	renameSync(`${path}.tmp`, path);
}

function loadSettings(): Settings {
	const settings: Settings = {
		hotkey: DEFAULT_HOTKEY,
		language: "auto",
		microphone: null,
		afterSpeak: "paste",
		sounds: false,
	};
	const raw = readJson(settingsPath) as Partial<Record<keyof Settings, unknown>> | undefined;
	if (raw === undefined) return settings;
	if (typeof raw !== "object" || raw === null) {
		keepBadFile(settingsPath);
		return settings;
	}
	let valid = true;
	if (typeof raw.hotkey === "string") {
		try {
			settings.hotkey = parseHotkey(raw.hotkey).label;
		} catch {
			valid = false;
		}
	} else if (raw.hotkey !== undefined) valid = false;
	if (typeof raw.language === "string" && raw.language !== "") settings.language = raw.language;
	else if (raw.language !== undefined) valid = false;
	if (typeof raw.microphone === "string" && raw.microphone !== "") settings.microphone = raw.microphone;
	else if (raw.microphone !== undefined && raw.microphone !== null) valid = false;
	if (raw.afterSpeak === "paste" || raw.afterSpeak === "copy") settings.afterSpeak = raw.afterSpeak;
	else if (raw.afterSpeak !== undefined) valid = false;
	if (typeof raw.sounds === "boolean") settings.sounds = raw.sounds;
	else if (raw.sounds !== undefined) valid = false;
	if (!valid) keepBadFile(settingsPath);
	return settings;
}

const settings = loadSettings();

function saveSettings(): void {
	writeJson(settingsPath, settings);
	sendSettings();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** "opening": the shortcut is held and the microphone opens (about 0.6 s). */
type State = "starting" | "idle" | "opening" | "recording" | "transcribing" | "error";
/** Why the state is "error", so the page can show the right fix. */
type ErrorCode = "ffmpeg" | "microphone" | "other";

function send(event: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

let state: State = "starting";
let stateMessage = "";
let stateCode: ErrorCode | null = null;

function setState(next: State, message = "", code: ErrorCode | null = null): void {
	state = next;
	stateMessage = message;
	stateCode = code;
	sendState();
}

function sendState(): void {
	send({ ev: "state", state, message: stateMessage, code: stateCode });
}

function sendSettings(): void {
	send({ ev: "settings", ...settings });
}

/** Details go to settings; an optional short message also appears in the pill. */
function fail(message: string, bubble?: string): void {
	send({ ev: "error", message, ...(bubble ? { bubble } : {}) });
}

// ---------------------------------------------------------------------------
// The last text (memory only)
// ---------------------------------------------------------------------------

interface LastText {
	/** ISO time of the clip. */
	at: string;
	text: string;
	/** Where the text went. */
	delivery: "pasted" | "copied" | "failed";
}

let last: LastText | null = null;

function sendLast(): void {
	send({ ev: "last", at: last?.at ?? null, delivery: last?.delivery ?? null });
}

// ---------------------------------------------------------------------------
// The ChatGPT sign-in
// ---------------------------------------------------------------------------

let signedIn = false;
let accountMessage = "";

let accountRevision = 0;

function signOut(message: string): void {
	accountRevision++;
	signedIn = false;
	accountMessage = message;
	sendAccount();
}

/** Read the credentials and refresh an expired access token. */
async function checkAccount(): Promise<void> {
	const revision = ++accountRevision;
	try {
		await ChatGPTAuth.load().ensureFresh();
		if (revision !== accountRevision) return;
		signedIn = true;
		accountMessage = "";
	} catch (error) {
		if (revision !== accountRevision) return;
		if (error instanceof AuthError) {
			signOut(error.message);
			return;
		}
		// The credentials are there, but the refresh failed (for example, no
		// network). That does not mean signed out.
		signedIn = true;
		accountMessage = "";
		fail((error as Error).message);
	}
	sendAccount();
}

function sendAccount(): void {
	send({ ev: "account", signedIn, message: accountMessage });
}

// ---------------------------------------------------------------------------
// Sounds
// ---------------------------------------------------------------------------

/** A short sine tone as a WAV file, with a soft start and end so it does not click. */
function tone(frequency: number, ms: number): Uint8Array {
	const count = Math.round((RECORD_SAMPLE_RATE * ms) / 1000);
	const fade = Math.round(RECORD_SAMPLE_RATE * 0.008);
	const pcm = Buffer.alloc(count * 2);
	for (let i = 0; i < count; i++) {
		const envelope = Math.min(1, i / fade, (count - 1 - i) / fade);
		const value = Math.sin((2 * Math.PI * frequency * i) / RECORD_SAMPLE_RATE) * envelope * 0.2;
		pcm.writeInt16LE(Math.round(value * 32767), i * 2);
	}
	return wavFromPcm(pcm, RECORD_SAMPLE_RATE, RECORD_CHANNELS);
}

const START_TONE = tone(880, 70);
const STOP_TONE = tone(660, 70);

function playTone(wav: Uint8Array): void {
	if (!settings.sounds) return;
	try {
		desktop.playSound(wav);
	} catch {
		// A missing sound is not worth an error.
	}
}

// ---------------------------------------------------------------------------
// Microphone
// ---------------------------------------------------------------------------

let mic: LiveMicrophone | null = null;
/** The microphone while it opens, so a release or a quit at that time can stop ffmpeg. */
let opening: LiveMicrophone | null = null;
let deviceNames: string[] = [];
/** The device that the shortcut opens. */
let currentDevice: string | null = null;

function sendDevices(): void {
	send({ ev: "devices", names: deviceNames, current: currentDevice });
}

function ffmpegFound(): boolean {
	return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error === undefined;
}

/** Find ffmpeg and the microphone in the settings. This does not open the microphone. */
function checkMic(): void {
	if (!ffmpegFound()) {
		deviceNames = [];
		currentDevice = null;
		sendDevices();
		setState("error", "codex-audio needs ffmpeg to record.", "ffmpeg");
		return;
	}
	deviceNames = audioDeviceNames();
	currentDevice = settings.microphone ?? deviceNames[0] ?? null;
	sendDevices();
	if (currentDevice === null) {
		setState("error", "No microphone was found.", "microphone");
	} else if (!deviceNames.includes(currentDevice)) {
		setState("error", `"${currentDevice}" is not connected.`, "microphone");
	} else {
		setState("idle");
	}
}

function closeMic(): void {
	const open = [mic, opening];
	// Clear first, so the exit of ffmpeg is not shown as an error.
	mic = null;
	opening = null;
	for (const one of open) one?.stop();
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

let hotkey: Hotkey = parseHotkey(settings.hotkey);
let hotkeyPaused = false;
/** True when the current hold of the shortcut must not start a clip. */
let holdUsed = false;
let heldSince = 0;
/** Counts presses, so a microphone that opens after the release is closed. */
let pressCount = 0;

/** The shortcut went down: open the microphone. Recording starts with the first audio. */
async function start(): Promise<void> {
	// After a microphone problem, each new press tries again.
	if (state === "error" && stateCode === "microphone") checkMic();
	if (state !== "idle" || currentDevice === null) return;
	const press = ++pressCount;
	if (hotkey.usesWin) desktop.maskStartMenu();
	setState("opening");
	try {
		const opened = await LiveMicrophone.open(micInputArgs(currentDevice), {
			onSpawn: (spawned) => {
				opening = spawned;
			},
		});
		if (press !== pressCount) {
			opened.stop();
			return;
		}
		opening = null;
		mic = opened;
		opened.begin();
		heldSince = Date.now();
		playTone(START_TONE);
		setState("recording");
		void opened.exited.then(() => {
			// A microphone that was closed on purpose is not an error.
			if (mic !== opened) return;
			mic = null;
			setState("error", opened.failureMessage() ?? "The microphone stopped.", "microphone");
		});
	} catch (error) {
		if (press !== pressCount) return;
		opening = null;
		setState("error", (error as Error).message, "microphone");
	}
}

/** The shortcut was released before the microphone was ready. */
function cancel(): void {
	pressCount++;
	if (hotkey.usesWin) desktop.maskStartMenu();
	closeMic();
	setState("idle");
}

async function stop(): Promise<void> {
	if (!mic || state !== "recording") return;
	if (hotkey.usesWin) desktop.maskStartMenu();
	const pcm = mic.end();
	closeMic();
	playTone(STOP_TONE);
	const heldMs = Date.now() - heldSince;
	// The text goes only to the window that has focus now. If the focus moves
	// during the upload, the text is copied, not pasted.
	const target = desktop.foregroundWindow();
	if (heldMs < MIN_CLIP_MS) {
		setState("idle");
		return;
	}
	setState("transcribing");
	try {
		await handleClip(pcm, target);
	} catch (error) {
		const signInFailed = error instanceof AuthError
			|| (error instanceof TranscriptionError && (error.status === 401 || error.status === 403));
		fail((error as Error).message, signInFailed
			? "Sign-in failed. Check settings."
			: "Transcription failed. Try again.");
		if (error instanceof AuthError) {
			signOut(error.message);
		} else if (error instanceof TranscriptionError && (error.status === 401 || error.status === 403)) {
			signOut("Your ChatGPT sign-in was rejected. Run `codex login` again.");
		} else {
			void checkAccount();
		}
	} finally {
		// (The cast: `state` can change during the await, which TypeScript does not see.)
		if ((state as State) === "transcribing") setState("idle");
	}
}

async function handleClip(pcm: Buffer, target: desktop.ForegroundWindow): Promise<void> {
	if (pcmPeak(pcm) < SILENT_PEAK) {
		fail("No speech was heard.", "No speech heard. Try again.");
		return;
	}
	const text = (
		await transcribeAudio(wavFromPcm(pcm, RECORD_SAMPLE_RATE, RECORD_CHANNELS), {
			filename: "codex-audio.wav",
			contentType: "audio/wav",
			language: settings.language === "auto" ? null : settings.language,
		})
	).trim();
	if (text === "") {
		fail("The transcription returned no text.", "No text returned. Try again.");
		return;
	}
	if (!signedIn) void checkAccount();

	// Keep the text even if the paste fails, so it can be copied again.
	let delivery: LastText["delivery"] = "failed";
	try {
		if (settings.afterSpeak === "copy") {
			await desktop.setClipboardText(text);
			delivery = "copied";
		} else {
			delivery = (await deliver(text, hotkey, target)).kind;
		}
	} catch (error) {
		fail(`The text was not pasted (${(error as Error).message}). Use "Copy it again".`,
			"Couldn't insert text. Open settings to copy it.");
	}
	last = { at: new Date().toISOString(), text, delivery };
	sendLast();
}

/**
 * Record while the shortcut is held. Send the clip when it is released.
 * A hold that starts while the last clip is still being sent starts its
 * recording as soon as the app is ready.
 */
function pollHotkey(): void {
	const down = !hotkeyPaused && allDown(hotkey);
	if (!down) {
		holdUsed = false;
		if (state === "opening") cancel();
		else if (state === "recording") void stop();
		return;
	}
	const canStart = state === "idle" || (state === "error" && stateCode === "microphone");
	if (!holdUsed && canStart) {
		holdUsed = true;
		void start();
	}
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** True from the press of the shortcut until the text is ready. */
function busy(): boolean {
	return state === "opening" || state === "recording" || state === "transcribing";
}

async function handleCommand(command: Record<string, unknown>): Promise<void> {
	switch (command.cmd) {
		case "getState":
			sendState();
			sendSettings();
			sendDevices();
			sendAccount();
			sendLast();
			return;
		case "pauseHotkey":
			// The settings page pauses the shortcut while it records a new one.
			hotkeyPaused = command.paused === true;
			// Keys still held from the capture must be released before a clip can start.
			holdUsed = true;
			return;
		case "setHotkey": {
			try {
				hotkey = parseHotkey(String(command.hotkey));
			} catch (error) {
				fail((error as Error).message);
				sendSettings();
				return;
			}
			holdUsed = true;
			settings.hotkey = hotkey.label;
			saveSettings();
			return;
		}
		case "setLanguage":
			settings.language = String(command.language || "auto");
			saveSettings();
			return;
		case "setMicrophone":
			if (busy()) {
				fail("Wait until the text is ready, then change the microphone.");
				sendSettings();
				return;
			}
			settings.microphone = typeof command.name === "string" && command.name !== "" ? command.name : null;
			saveSettings();
			checkMic();
			return;
		case "listDevices":
			// Listing runs ffmpeg and blocks for a moment, so never do it during a clip.
			if (!busy()) checkMic();
			return;
		case "setAfterSpeak":
			settings.afterSpeak = command.value === "copy" ? "copy" : "paste";
			saveSettings();
			return;
		case "setSounds":
			settings.sounds = command.on === true;
			saveSettings();
			// Let the user hear the tone they turned on.
			playTone(START_TONE);
			return;
		case "copyLast":
			if (!last) {
				fail("There is no last text to copy.");
				return;
			}
			await desktop.setClipboardText(last.text);
			send({ ev: "copied" });
			return;
		case "checkAccount":
			await checkAccount();
			return;
		default:
			fail(`unknown command: ${JSON.stringify(command)}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	if (line.trim() === "") return;
	let command: Record<string, unknown>;
	try {
		command = JSON.parse(line) as Record<string, unknown>;
	} catch {
		fail(`bad command: ${line}`);
		return;
	}
	handleCommand(command).catch((error: Error) => fail(error.message));
});
// The app closed our stdin: it has quit, so quit too.
input.on("close", () => {
	closeMic();
	process.exit(0);
});
process.once("exit", closeMic);

sendSettings();
sendLast();
// The check can use the network, so do not wait for it.
void checkAccount();
desktop.foregroundWindow(); // Load the Windows libraries now.
setInterval(pollHotkey, POLL_MS);
setInterval(() => {
	if (mic && state === "recording") send({ ev: "level", level: mic.level() });
}, LEVEL_MS);
checkMic();
