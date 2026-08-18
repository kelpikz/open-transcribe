/** Terminal rendering for the transcript stages. */

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CLEAR = "\r\x1b[2K";

/**
 * Draws the two transcript stages distinctly.
 *
 * Stage 1 is the in-flight guess for the segment you're speaking now: it
 * rewrites itself in place on one line and is never part of the output.
 * Stage 2 is a settled segment, printed once and kept.
 * Both go to stderr; only the assembled final text reaches stdout.
 */
export class Renderer {
	static readonly DIM = DIM;
	static readonly GREEN = GREEN;
	static readonly BOLD = BOLD;
	static readonly RESET = RESET;
	static readonly CLEAR = CLEAR;

	buf = "";
	liveOpen = false;

	private readonly glyphs: { live: string; ok: string; rule: string };

	constructor(
		readonly enabled: boolean,
		/**
		 * Rewriting one line in place only makes sense on a terminal; piped
		 * output gets settled segments only, with no cursor control at all.
		 */
		readonly interactive: boolean,
		readonly color: boolean,
	) {
		// Node always writes UTF-8 to stderr, so unlike the Python there is no
		// encoding to interrogate. CODEX_AUDIO_ASCII covers consoles whose font
		// or code page cannot show the glyphs.
		this.glyphs = process.env.CODEX_AUDIO_ASCII
			? { live: "...", ok: "*", rule: "-" }
			: { live: "…", ok: "✓", rule: "─" };
	}

	private c(code: string): string {
		return this.color ? code : "";
	}

	private clearLive(): string {
		if (this.interactive && this.liveOpen) {
			this.liveOpen = false;
			return CLEAR;
		}
		return "";
	}

	delta(delta: string): void {
		this.buf += delta;
		if (!(this.enabled && this.interactive)) return;
		// Keep the live line to one terminal row so it overwrites cleanly.
		const text = this.buf.slice(-110);
		process.stderr.write(
			`${CLEAR}${this.c(DIM)}  ${this.glyphs.live} ${text}${this.c(RESET)}`,
		);
		this.liveOpen = true;
	}

	final(text: string): void {
		this.buf = "";
		if (!this.enabled) return;
		process.stderr.write(
			`${this.clearLive()}${this.c(GREEN)}  ${this.glyphs.ok}${this.c(RESET)} ${text}\n`,
		);
	}

	status(message: string): void {
		if (!this.enabled) return;
		process.stderr.write(
			`${this.clearLive()}${this.c(DIM)}  ${message}${this.c(RESET)}\n`,
		);
	}

	done(): void {
		if (!this.enabled) return;
		process.stderr.write(
			`${this.clearLive()}${this.c(DIM)}${this.glyphs.rule.repeat(40)}${this.c(RESET)}\n`,
		);
	}
}
