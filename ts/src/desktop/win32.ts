/**
 * The Windows desktop calls that `--listen` needs, through bun:ffi.
 *
 *   - Key state: GetAsyncKeyState sees every key, in every app, without a
 *     keyboard hook or a message loop. We poll it.
 *   - Key presses: keybd_event, to send Ctrl+V and the Start-menu mask key.
 *   - The foreground window: to choose between paste and clipboard only.
 *   - The clipboard: read every format, write text, put the old content back.
 *   - Sound: play a short WAV from memory.
 *
 * The libraries load on first use, so importing this file on another
 * platform does nothing until a function is called.
 */

import { dlopen, FFIType, toArrayBuffer, type Pointer } from "bun:ffi";

const { i32, u32, u8, i16, ptr, u64, void: none } = FFIType;

let libs: ReturnType<typeof load> | null = null;

function load() {
	const user32 = dlopen("user32.dll", {
		GetAsyncKeyState: { args: [i32], returns: i16 },
		keybd_event: { args: [u8, u8, u32, u64], returns: none },
		GetForegroundWindow: { args: [], returns: ptr },
		GetClassNameW: { args: [ptr, ptr, i32], returns: i32 },
		GetWindowTextW: { args: [ptr, ptr, i32], returns: i32 },
		CreateWindowExW: {
			args: [u32, ptr, ptr, u32, i32, i32, i32, i32, ptr, ptr, ptr, ptr], returns: ptr,
		},
		DestroyWindow: { args: [ptr], returns: i32 },
		OpenClipboard: { args: [ptr], returns: i32 },
		CloseClipboard: { args: [], returns: i32 },
		EmptyClipboard: { args: [], returns: i32 },
		EnumClipboardFormats: { args: [u32], returns: u32 },
		GetClipboardData: { args: [u32], returns: ptr },
		SetClipboardData: { args: [u32, ptr], returns: ptr },
		RegisterClipboardFormatW: { args: [ptr], returns: u32 },
		GetClipboardSequenceNumber: { args: [], returns: u32 },
	});
	const kernel32 = dlopen("kernel32.dll", {
		GlobalAlloc: { args: [u32, u64], returns: ptr },
		GlobalLock: { args: [ptr], returns: ptr },
		GlobalUnlock: { args: [ptr], returns: i32 },
		GlobalSize: { args: [ptr], returns: u64 },
		RtlMoveMemory: { args: [ptr, ptr, u64], returns: none },
		GlobalFree: { args: [ptr], returns: ptr },
	});
	const winmm = dlopen("winmm.dll", {
		PlaySoundW: { args: [ptr, ptr, u32], returns: i32 },
	});
	return { user32: user32.symbols, kernel32: kernel32.symbols, winmm: winmm.symbols };
}

function win() {
	if (process.platform !== "win32") {
		throw new Error("--listen works only on Windows");
	}
	libs ??= load();
	return libs;
}

function wide(text: string): Buffer {
	return Buffer.from(`${text}\0`, "utf16le");
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const KEYEVENTF_KEYUP = 0x2;
const VK_CONTROL = 0x11;
const VK_V = 0x56;
/** An unassigned key. Pressing it stops a Win key release from opening Start. */
const VK_MASK = 0xe8;

/** True while the key with this virtual-key code is down, in any app. */
export function isKeyDown(vk: number): boolean {
	return (win().user32.GetAsyncKeyState(vk) & 0x8000) !== 0;
}

function tap(vk: number): void {
	const { keybd_event } = win().user32;
	keybd_event(vk, 0, 0, 0);
	keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
}

/**
 * Stop Windows from opening the Start menu when the Win key goes up.
 * Windows opens Start only if no other key came between Win down and Win up.
 */
export function maskStartMenu(): void {
	tap(VK_MASK);
}

export function sendCtrlV(): void {
	const { keybd_event } = win().user32;
	keybd_event(VK_CONTROL, 0, 0, 0);
	keybd_event(VK_V, 0, 0, 0);
	keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
	keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
}

// ---------------------------------------------------------------------------
// Foreground window
// ---------------------------------------------------------------------------

/** Window classes of the desktop and the taskbar: no text field to paste in. */
const SHELL_CLASSES = new Set([
	"Progman",
	"WorkerW",
	"Shell_TrayWnd",
	"Shell_SecondaryTrayWnd",
]);

export interface ForegroundWindow {
	/** The window handle, or null for no window. */
	hwnd: Pointer | null;
	/** False for no window, the desktop, or the taskbar. */
	canPaste: boolean;
	className: string;
	title: string;
}

export function foregroundWindow(): ForegroundWindow {
	const { user32 } = win();
	const hwnd = user32.GetForegroundWindow();
	if (hwnd === null) return { hwnd: null, canPaste: false, className: "", title: "" };
	const className = windowString(user32.GetClassNameW, hwnd);
	const title = windowString(user32.GetWindowTextW, hwnd);
	return { hwnd, canPaste: !SHELL_CLASSES.has(className), className, title };
}

function windowString(
	getter: (hwnd: Pointer, buffer: Buffer, size: number) => number,
	hwnd: Pointer,
): string {
	const buffer = Buffer.alloc(512);
	const length = getter(hwnd, buffer, buffer.length / 2);
	return buffer.toString("utf16le", 0, Math.max(0, length) * 2);
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x2;

/**
 * Formats whose data is a GDI handle or another non-memory handle, not an
 * HGLOBAL. GlobalSize on such a handle reads a bad address and crashes.
 */
const HANDLE_FORMATS = new Set([
	2, // CF_BITMAP
	3, // CF_METAFILEPICT (holds an HMETAFILE inside)
	9, // CF_PALETTE
	14, // CF_ENHMETAFILE
	0x80, // CF_OWNERDISPLAY
	0x82, // CF_DSPBITMAP
	0x83, // CF_DSPMETAFILEPICT
	0x8e, // CF_DSPENHMETAFILE
]);

function isMemoryFormat(format: number): boolean {
	// 0x200–0x2FF: private formats, 0x300–0x3FF: GDI objects. Neither is
	// sure to be an HGLOBAL.
	return !HANDLE_FORMATS.has(format) && !(format >= 0x200 && format <= 0x3ff);
}

/** Every clipboard format that holds plain memory, keyed by format id. */
export type ClipboardSnapshot = Map<number, Uint8Array>;

/** Another app can hold the clipboard for a moment, so try a few times. */
async function openClipboard(owner: Pointer | null = null): Promise<void> {
	const { user32 } = win();
	for (let attempt = 0; attempt < 20; attempt++) {
		if (user32.OpenClipboard(owner)) return;
		await Bun.sleep(25);
	}
	throw new Error("the clipboard is in use by another app");
}

export function clipboardSequence(): number {
	return win().user32.GetClipboardSequenceNumber();
}

/**
 * Copy the clipboard content. Formats that are not plain memory (such as a
 * bitmap handle) are skipped; Windows makes them again from the formats
 * that are kept, for example a bitmap from CF_DIB.
 */
export async function readClipboard(): Promise<ClipboardSnapshot> {
	const { user32, kernel32 } = win();
	const snapshot: ClipboardSnapshot = new Map();
	await openClipboard();
	try {
		let format = 0;
		while ((format = user32.EnumClipboardFormats(format)) !== 0) {
			if (!isMemoryFormat(format)) continue;
			const handle = user32.GetClipboardData(format);
			if (handle === null) continue;
			const size = Number(kernel32.GlobalSize(handle));
			if (size === 0) continue;
			const data = kernel32.GlobalLock(handle);
			if (data === null) continue;
			snapshot.set(format, new Uint8Array(toArrayBuffer(data, 0, size)).slice());
			kernel32.GlobalUnlock(handle);
		}
	} finally {
		user32.CloseClipboard();
	}
	return snapshot;
}

/**
 * Replace the clipboard content with these formats. Returns the number of
 * formats the clipboard accepted.
 */
export async function writeClipboard(snapshot: ClipboardSnapshot): Promise<number> {
	const { user32, kernel32 } = win();
	// Destroy the owner after each write. Bun does not pump window messages.
	const owner = user32.CreateWindowExW(0, wide("STATIC"), null, 0, 0, 0, 0, 0, null, null, null, null);
	if (owner === null) throw new Error("the clipboard owner window could not be created");
	let opened = false;
	let written = 0;
	try {
		await openClipboard(owner);
		opened = true;
		if (!user32.EmptyClipboard()) throw new Error("the clipboard could not be cleared");
		for (const [format, bytes] of snapshot) {
			const handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, Math.max(1, bytes.byteLength));
			if (handle === null) continue;
			const data = kernel32.GlobalLock(handle);
			if (data === null) {
				kernel32.GlobalFree(handle);
				continue;
			}
			kernel32.RtlMoveMemory(data, bytes, bytes.byteLength);
			kernel32.GlobalUnlock(handle);
			// On success the clipboard owns the memory. On failure we still own it.
			if (user32.SetClipboardData(format, handle) === null) kernel32.GlobalFree(handle);
			else written++;
		}
	} finally {
		if (opened) user32.CloseClipboard();
		user32.DestroyWindow(owner);
	}
	return written;
}

/**
 * Put text on the clipboard. With `temporary`, the text is also marked so
 * that clipboard history (Win+V) and cloud clipboard do not keep it.
 */
export async function setClipboardText(
	text: string,
	options: { temporary?: boolean } = {},
): Promise<void> {
	const snapshot: ClipboardSnapshot = new Map([[CF_UNICODETEXT, wide(text)]]);
	if (options.temporary) {
		const { user32 } = win();
		for (const name of [
			"ExcludeClipboardContentFromMonitorProcessing",
			"CanIncludeInClipboardHistory",
			"CanUploadToCloudClipboard",
		]) {
			const format = user32.RegisterClipboardFormatW(wide(name));
			// The two "Can..." formats take a DWORD; zero means "no".
			if (format !== 0) snapshot.set(format, new Uint8Array(4));
		}
	}
	if ((await writeClipboard(snapshot)) === 0) {
		throw new Error("the clipboard did not accept the text");
	}
}

/** Read the clipboard as text, or null if it holds no text. */
export async function getClipboardText(): Promise<string | null> {
	const bytes = (await readClipboard()).get(CF_UNICODETEXT);
	if (bytes === undefined) return null;
	const text = Buffer.from(bytes).toString("utf16le");
	const end = text.indexOf("\0");
	return end === -1 ? text : text.slice(0, end);
}

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

/**
 * Show a short Windows notification. It runs in a separate PowerShell
 * process, so it never blocks dictation.
 */
export function notify(title: string, message: string): void {
	const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
	const script = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"$n = New-Object System.Windows.Forms.NotifyIcon",
		"$n.Icon = [System.Drawing.SystemIcons]::Information",
		"$n.Visible = $true",
		`$n.ShowBalloonTip(3000, ${quote(title)}, ${quote(message)}, 'Info')`,
		"Start-Sleep -Seconds 4",
		"$n.Dispose()",
	].join("; ");
	const child = Bun.spawn(
		["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
		{ stdio: ["ignore", "ignore", "ignore"] },
	);
	child.unref();
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

const SND_ASYNC = 0x1;
const SND_NODEFAULT = 0x2;
const SND_MEMORY = 0x4;

/** The sound that plays now. Windows reads it while it plays, so keep it alive. */
let playing: Uint8Array | null = null;

/** Play a WAV file from memory. Returns at once; a new sound stops the old one. */
export function playSound(wav: Uint8Array): void {
	playing = wav;
	win().winmm.PlaySoundW(playing, null, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
}
