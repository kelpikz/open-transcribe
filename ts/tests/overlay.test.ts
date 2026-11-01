import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

function overlay() {
	class Element {
		children: Element[] = [];
		style: Record<string, string> = {};
		textContent = "";
		title = "";
		hidden = false;
		classes = new Set<string>();
		classList = {
			add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
			remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
			toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name),
		};
		appendChild(node: Element) { this.children.push(node); }
		querySelectorAll() { return this.children; }
	}
	const nodes = { pill: new Element(), wave: new Element(), time: new Element(), message: new Element() };
	nodes.message.hidden = true;
	let receive!: (event: { payload: Record<string, unknown> }) => void;
	const intervals = new Set<() => void>();
	const context = createContext({
		window: { __TAURI__: { event: { listen: (_name: string, callback: typeof receive) => { receive = callback; } } } },
		document: { getElementById: (id: keyof typeof nodes) => nodes[id], createElement: () => new Element() },
		setInterval: (fn: () => void) => { intervals.add(fn); return fn; },
		clearInterval: (fn: () => void) => intervals.delete(fn),
	});
	runInContext(readFileSync(new URL("../../app/ui/overlay.js", import.meta.url), "utf8"), context);
	return { nodes, intervals, send: (payload: Record<string, unknown>) => receive({ payload }) };
}

test("the pill still shows recording levels and a timer", () => {
	const ui = overlay();
	ui.send({ ev: "state", state: "opening" });
	expect(ui.nodes.pill.classes.has("opening")).toBe(true);
	ui.send({ ev: "state", state: "recording" });
	ui.send({ ev: "level", level: 1 });
	expect(ui.nodes.time.textContent).toBe("0:00");
	expect(ui.intervals.size).toBe(1);
	expect(ui.nodes.wave.children.at(-1)?.style.height).toBe("22px");
});

test("a dictation error survives the immediate idle event without showing raw server details", () => {
	const ui = overlay();
	ui.send({ ev: "state", state: "recording" });
	ui.send({ ev: "state", state: "transcribing" });
	ui.send({ ev: "error", message: "500: internal server details", bubble: "Transcription failed. Try again." });
	ui.send({ ev: "state", state: "idle" });
	expect(ui.nodes.pill.classes.has("error")).toBe(true);
	expect(ui.nodes.pill.classes.has("busy")).toBe(false);
	expect(ui.nodes.message.hidden).toBe(false);
	expect(ui.nodes.message.textContent).toBe("Transcription failed. Try again.");
	expect(ui.intervals.size).toBe(0);
});

test("a new recording immediately replaces an error", () => {
	const ui = overlay();
	ui.send({ ev: "error", bubble: "Try again." });
	ui.send({ ev: "state", state: "opening" });
	expect(ui.nodes.pill.classes.has("error")).toBe(false);
	expect(ui.nodes.pill.classes.has("opening")).toBe(true);
	expect(ui.nodes.message.hidden).toBe(true);
	expect(ui.nodes.time.textContent).toBe("0:00");
});

test("microphone failures and a stopped sidecar have readable messages", () => {
	const ui = overlay();
	ui.send({ ev: "state", state: "error", code: "microphone", message: "ffmpeg: device disconnected" });
	expect(ui.nodes.message.textContent).toBe("Microphone unavailable. Check settings.");
	ui.send({ ev: "state", state: "error", bubble: "Background process stopped. Restart the app." });
	expect(ui.nodes.message.textContent).toBe("Background process stopped. Restart the app.");
});

test("settings-only errors do not interrupt dictation", () => {
	const ui = overlay();
	ui.send({ ev: "state", state: "recording" });
	ui.send({ ev: "error", message: "Wait until the text is ready, then change the microphone." });
	expect(ui.nodes.pill.classes.has("error")).toBe(false);
	expect(ui.nodes.message.hidden).toBe(true);
	expect(ui.intervals.size).toBe(1);
});
