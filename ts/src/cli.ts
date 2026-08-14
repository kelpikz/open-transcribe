/**
 * codex-audio — speak, get text. Uses your ChatGPT subscription via Codex's login.
 *
 * Ported from `codex_audio/cli.py`. This is the Bun-specific adapter: it is
 * the only module in the port allowed to use `Bun.*` / `import.meta.main`
 * (see PORTING.md rule 3). It wires the runtime-agnostic pieces (transcribe.ts,
 * audio.ts) into an actual command-line tool.
 *
 * The CLI routes through the upload backend (transcribe.ts) exclusively,
 * matching the current Python — realtime.ts (the legacy WebRTC backend) is
 * ported for completeness but never called from here.
 *
 * Testability: every side-effecting dependency (the transcription backend,
 * microphone capture, device listing, stdout/stderr, TTY-ness, the stderr
 * "encoding" used for the glyph fallback) is injectable via `CliDeps`, so
 * `main()` can be driven end to end in tests without the network, real
 * credentials, or a real terminal. Nothing in this file touches
 * `~/.codex/auth.json` directly — that happens inside transcribe.ts's
 * default `uploadBackend`, which is exactly what production uses when no
 * override is supplied.
 */

import type { ParsedArgs, TranscriptionBackend } from "./contract";
import { pyFloat } from "./auth";
import { listDevices as listDevicesImpl, recordMicrophone as recordMicrophoneImpl } from "./audio";
import { codepointSliceLast, pyTruthy } from "./pycompat";
import { DEFAULT_LANGUAGE, DEFAULT_MODEL, TRANSCRIBE_MODELS, uploadBackend } from "./transcribe";

const PROG = "codex-audio";

// ------------------------------------------------------------------- _err

/** Minimal shape written to: matches both `process.stderr`/`process.stdout` and a test double. */
export interface Sink {
  write(s: string): void;
}

/**
 * Ported from `codex_audio/cli.py::_err`. Kept the Python's leading-underscore
 * name verbatim per the porting brief's surface list (unlike the other
 * private helpers, which get camelCase names).
 *
 * Python: `print(msg, file=sys.stderr, flush=True)`. `sink.write` on
 * `process.stderr` is unbuffered for a TTY/pipe in the same practical sense,
 * so there is no separate flush step to model here.
 */
export function _err(msg: string, sink: Sink = process.stderr): void {
  sink.write(`${msg}\n`);
}

// ---------------------------------------------------------- stderr encoding

/**
 * Best-effort detection of whether the terminal can render the glyphs
 * Renderer wants (… ✓ ─).
 *
 * Python reads `sys.stderr.encoding` directly — CPython sets that from the
 * OS locale/console codepage at startup. Node/Bun expose no equivalent: a
 * `Writable` stream has no `.encoding` reflecting the *console's* codepage
 * (only `.setDefaultEncoding()`, which is about what Node assumes when you
 * write, not what the terminal can display). There is no portable API that
 * answers "can this stderr render U+2713".
 *
 * So this is a heuristic, in the same spirit as the well-known
 * `is-unicode-supported` pattern: non-Windows terminals are treated as
 * UTF-8-capable (true for effectively every modern Unix shell locale), and
 * on Windows the legacy `cmd.exe`/PowerShell console (codepage 1252 on most
 * Western installs — see implementationNotes.md, confirmed on the machine
 * this was ported on) is assumed *unless* an env var signals a
 * unicode-capable host (Windows Terminal via `WT_SESSION`, VS Code's
 * integrated terminal via `TERM_PROGRAM`, or CI, which usually captures
 * UTF-8 fine).
 *
 * `CODEX_AUDIO_STDERR_ENCODING` is an explicit escape hatch: set it to force
 * a specific encoding name (e.g. "ascii") regardless of the heuristic above.
 * `env`/`platform` are parameters (not read from `process` directly) so both
 * branches are unit-testable without mutating global state.
 */
export function detectStderrEncoding(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.CODEX_AUDIO_STDERR_ENCODING) return env.CODEX_AUDIO_STDERR_ENCODING;
  if (platform !== "win32") return "utf-8";
  const unicodeFriendly =
    Boolean(env.WT_SESSION) || env.TERM_PROGRAM === "vscode" || env.ConEmuTask === "{cmd::Cmder}" || Boolean(env.CI);
  return unicodeFriendly ? "utf-8" : "cp1252";
}

// cp1252's 0x80-0x9F block replaces Latin-1's C1 controls with these
// specific characters; everything else in 0xA0-0xFF maps 1:1 onto its
// Unicode code point (cp1252 is Latin-1-compatible there).
const CP1252_HIGH_BLOCK: ReadonlySet<number> = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018,
  0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function cp1252CanEncode(codePoint: number): boolean {
  if (codePoint <= 0x7f) return true;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return true;
  return CP1252_HIGH_BLOCK.has(codePoint);
}

/**
 * Mirrors the effect of Python's `"…✓─".encode(enc)` try/except: true if
 * every character in `text` is representable in `encoding`, false if not
 * (Python's `UnicodeEncodeError`) or if `encoding` isn't a name this
 * function knows (Python's `LookupError` on a bad codec name) — either way
 * Renderer falls back to ASCII-safe glyphs.
 */
export function canEncode(text: string, encoding: string): boolean {
  const norm = encoding.toLowerCase().replace(/[-_]/g, "");
  if (norm === "utf8") return true;
  if (norm === "ascii" || norm === "usascii") {
    return Array.from(text).every((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f);
  }
  if (norm === "cp1252" || norm === "windows1252" || norm === "win1252") {
    return Array.from(text).every((ch) => cp1252CanEncode(ch.codePointAt(0) ?? 0));
  }
  return false;
}

// ---------------------------------------------------------------- Renderer

/**
 * Draws the two transcript stages distinctly.
 *
 * Stage 1 is the in-flight guess for the segment you're speaking now: it
 * rewrites itself in place on one line and is never part of the output.
 * Stage 2 is a settled segment, printed once and kept.
 * Both go to stderr; only the assembled final text reaches stdout.
 *
 * Ported from `codex_audio/cli.py::Renderer`. See `fixtures/renderer.json`
 * for the byte-exact oracle this is checked against — every ANSI escape,
 * indent, and newline placement here is load-bearing.
 */
export class Renderer {
  static readonly DIM = "\x1b[2m";
  static readonly GREEN = "\x1b[32m";
  static readonly BOLD = "\x1b[1m";
  static readonly RESET = "\x1b[0m";
  static readonly CLEAR = "\r\x1b[2K";

  readonly enabled: boolean;
  // Rewriting one line in place only makes sense on a terminal; piped
  // output gets settled segments only, with no cursor control at all.
  readonly interactive: boolean;
  readonly color: boolean;
  buf = "";
  private liveOpen = false;

  readonly gLive: string;
  readonly gOk: string;
  readonly gRule: string;

  private readonly sink: Sink;

  constructor(
    enabled: boolean,
    interactive: boolean,
    color: boolean,
    sink: Sink = process.stderr,
    encoding: string = detectStderrEncoding(),
  ) {
    this.enabled = enabled;
    this.interactive = interactive;
    this.color = color;
    this.sink = sink;

    // Windows consoles often hand us cp1252, which can't encode ✓ or ─.
    if (canEncode("…✓─", encoding)) {
      this.gLive = "…";
      this.gOk = "✓";
      this.gRule = "─";
    } else {
      this.gLive = "...";
      this.gOk = "*";
      this.gRule = "-";
    }
  }

  private c(code: string): string {
    return this.color ? code : "";
  }

  private clear(): string {
    if (this.interactive && this.liveOpen) {
      this.liveOpen = false;
      return Renderer.CLEAR;
    }
    return "";
  }

  delta(delta: string): void {
    this.buf += delta;
    if (!(this.enabled && this.interactive)) return;
    // Keep the live line to one terminal row so it overwrites cleanly.
    const text = codepointSliceLast(this.buf, 110);
    this.sink.write(`${Renderer.CLEAR}${this.c(Renderer.DIM)}  ${this.gLive} ${text}${this.c(Renderer.RESET)}`);
    this.liveOpen = true;
  }

  final(text: string): void {
    // Cleared before the enabled check on purpose: a disabled renderer must
    // still reset its buffer (see fixtures/renderer.json "quiet" mode).
    this.buf = "";
    if (!this.enabled) return;
    this.sink.write(`${this.clear()}${this.c(Renderer.GREEN)}  ${this.gOk}${this.c(Renderer.RESET)} ${text}\n`);
  }

  status(msg: string): void {
    if (!this.enabled) return;
    this.sink.write(`${this.clear()}${this.c(Renderer.DIM)}  ${msg}${this.c(Renderer.RESET)}\n`);
  }

  done(): void {
    if (!this.enabled) return;
    const rule = this.gRule.repeat(40);
    this.sink.write(`${this.clear()}${this.c(Renderer.DIM)}${rule}${this.c(Renderer.RESET)}\n`);
  }
}

// ----------------------------------------------------------------- deps

/**
 * Everything `main()` can do that touches the outside world, all
 * injectable. Production leaves this empty and gets the real network
 * backend, real mic capture, real stdio, and best-effort TTY/encoding
 * detection; tests supply stand-ins for every field so nothing here ever
 * hits the network, a real credentials file, or a real terminal/microphone.
 */
export interface CliDeps {
  /** Defaults to `uploadBackend` (transcribe.ts) — the route Codex Desktop's composer mic uses. */
  backend?: TranscriptionBackend;
  /** Defaults to `recordMicrophone` (audio.ts). */
  recordMicrophone?: (device?: string | number | null) => Promise<Uint8Array>;
  /** Defaults to `listDevices` (audio.ts). */
  listDevices?: () => string;
  stdout?: Sink;
  stderr?: Sink;
  /** Defaults to `Boolean(process.stderr.isTTY)`. */
  isTTY?: boolean;
  /** Defaults to `detectStderrEncoding()`. */
  encoding?: string;
}

interface ResolvedDeps {
  backend: TranscriptionBackend;
  recordMicrophone: (device?: string | number | null) => Promise<Uint8Array>;
  listDevices: () => string;
  stdout: Sink;
  stderr: Sink;
  isTTY: boolean;
  encoding: string;
}

function resolveDeps(deps: CliDeps): ResolvedDeps {
  return {
    backend: deps.backend ?? uploadBackend,
    recordMicrophone: deps.recordMicrophone ?? recordMicrophoneImpl,
    listDevices: deps.listDevices ?? listDevicesImpl,
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
    isTTY: deps.isTTY ?? Boolean(process.stderr.isTTY),
    encoding: deps.encoding ?? detectStderrEncoding(),
  };
}

// ------------------------------------------------------------- _render_final

/** Ported from `codex_audio/cli.py::_render_final`. */
export function renderFinal(text: string, args: Pick<ParsedArgs, "quiet" | "no_color">, deps: CliDeps = {}): void {
  if (args.quiet) return;
  const { stderr, isTTY, encoding } = resolveDeps(deps);
  const render = new Renderer(true, false, isTTY && !args.no_color, stderr, encoding);
  render.final(text);
  render.done();
}

// ---------------------------------------------------------------- _mic_main

/** Ported from `codex_audio/cli.py::_mic_main`. */
export async function micMain(args: ParsedArgs, deps: CliDeps = {}): Promise<string> {
  const resolved = resolveDeps(deps);
  if (!args.quiet) _err("Recording — press Enter to stop.", resolved.stderr);
  const data = await resolved.recordMicrophone(args.device);
  if (!args.quiet) _err("transcribing…", resolved.stderr);
  const text = await resolved.backend.transcribeAudio(data, {
    filename: "codex-audio.wav",
    content_type: "audio/wav",
    language: args.language === "auto" ? null : args.language,
  });
  renderFinal(text, args, deps);
  return text;
}

// --------------------------------------------------------------- _file_main

/** Ported from `codex_audio/cli.py::_file_main`. */
export async function fileMain(args: ParsedArgs, deps: CliDeps = {}): Promise<string> {
  const resolved = resolveDeps(deps);
  if (!args.quiet) _err("transcribing…", resolved.stderr);
  const text = await resolved.backend.transcribeFile(args.input as string, {
    language: args.language === "auto" ? null : args.language,
  });
  renderFinal(text, args, deps);
  return text;
}

// ------------------------------------------------------------- build_parser

/**
 * Thrown internally when argument parsing wants to end the process, mirroring
 * argparse's `SystemExit`. Python lets that `SystemExit` propagate all the
 * way out of `main()` uncaught (parse_args() is called *outside* main()'s
 * try/except) — the interpreter itself turns it into the process exit code.
 * `main()` here is a plain async function that must always resolve to a
 * number so it stays testable without spawning a process, so it catches this
 * one sentinel type and translates it into an ordinary return value. The
 * observable behaviour (exit code, stderr message) is identical either way;
 * only the propagation mechanism differs.
 */
export class ArgparseExit extends Error {
  constructor(
    public readonly code: number,
    message = "",
  ) {
    super(message);
    this.name = "ArgparseExit";
  }
}

type OptionKind = "store_true" | "string" | "int" | "float" | "choice";

interface OptionSpec {
  flags: string[];
  dest: keyof ParsedArgs;
  kind: OptionKind;
  choices?: string[];
  default: unknown;
}

const OPTION_SPECS: OptionSpec[] = [
  { flags: ["--device"], dest: "device", kind: "string", default: null },
  { flags: ["--model"], dest: "model", kind: "string", default: DEFAULT_MODEL },
  { flags: ["--list-devices"], dest: "list_devices", kind: "store_true", default: false },
  { flags: ["--language", "-l"], dest: "language", kind: "string", default: DEFAULT_LANGUAGE },
  { flags: ["--prompt"], dest: "prompt", kind: "string", default: null },
  { flags: ["--stream"], dest: "stream", kind: "store_true", default: false },
  { flags: ["--silence-ms"], dest: "silence_ms", kind: "int", default: 500 },
  {
    flags: ["--noise-reduction"],
    dest: "noise_reduction",
    kind: "choice",
    choices: ["near_field", "far_field", "none"],
    default: "none",
  },
  { flags: ["--json"], dest: "json", kind: "store_true", default: false },
  { flags: ["--quiet", "-q"], dest: "quiet", kind: "store_true", default: false },
  { flags: ["--no-partials"], dest: "no_partials", kind: "store_true", default: false },
  { flags: ["--no-color"], dest: "no_color", kind: "store_true", default: false },
  { flags: ["--raw-events"], dest: "raw_events", kind: "store_true", default: false },
  { flags: ["--session"], dest: "session", kind: "string", default: null },
  { flags: ["--drain"], dest: "drain", kind: "float", default: 2.0 },
];

function helpText(): string {
  const lines = [
    `usage: ${PROG} [-h] [--device DEVICE] [--model MODEL] [--list-devices]`,
    `                   [--language LANGUAGE] [--prompt PROMPT] [--stream]`,
    `                   [--silence-ms SILENCE_MS]`,
    "                   [--noise-reduction {near_field,far_field,none}] [--json]",
    "                   [--quiet] [--no-partials] [--no-color] [--raw-events]",
    "                   [--session SESSION] [--drain DRAIN]",
    "                   [input]",
    "",
    "Speech to text using your ChatGPT subscription (via `codex login`).",
    "",
    "positional arguments:",
    "  input                 audio file to transcribe; omit to use the microphone",
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --device DEVICE       input device index or name (see --list-devices)",
    `  --model MODEL         compatibility option; desktop endpoint chooses the`,
    `                        model (default: ${DEFAULT_MODEL}; known: ${TRANSCRIBE_MODELS.join(", ")})`,
    "  --list-devices        list audio input devices and exit",
    "  --language, -l LANGUAGE",
    `                        ISO-639-1 language hint (default: ${DEFAULT_LANGUAGE}). Use`,
    "                        'auto' to let the model detect it per segment",
    "  --prompt PROMPT       context hint to bias spelling of names/jargon",
    "  --stream              compatibility option; upload transcription returns",
    "                        one final transcript",
    "  --silence-ms SILENCE_MS",
    "                        compatibility option; upload transcription is not",
    "                        streamed",
    "  --noise-reduction {near_field,far_field,none}",
    "                        compatibility option; noise reduction is selected by",
    "                        the desktop service",
    "  --json                emit JSON instead of plain text",
    "  --quiet, -q           no progress output on stderr",
    "  --no-partials         show only settled segments, not live guesses",
    "  --no-color            disable ANSI colour",
    "  --raw-events          compatibility option; upload has no protocol events",
    "  --session SESSION     compatibility option; upload has no session JSON",
    "  --drain DRAIN         compatibility option; upload has no in-flight drain",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Reasonable-faith reproduction of Python's `int(s)` for argparse's
 * `type=int` — accepts optional surrounding whitespace, an optional sign,
 * and PEP-515 single underscores between digits; rejects anything with a
 * decimal point or other non-digit content. Not exported/shared via
 * pycompat.ts because nothing else in the port needs int-string parsing
 * (see `pyFloat`, reused from auth.ts, for the --drain float case, which
 * *is* shared).
 */
function pyInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(trimmed)) return null;
  return Number(trimmed.replace(/_/g, ""));
}

function primaryFlagName(spec: OptionSpec): string {
  return spec.flags[0] as string;
}

function usageLine(): string {
  return `usage: ${PROG} [-h] [options] [input]`;
}

function argError(stderr: Sink, message: string): never {
  stderr.write(`${usageLine()}\n${PROG}: error: ${message}\n`);
  throw new ArgparseExit(2);
}

export interface ArgParser {
  parseArgs(argv: string[], stderr?: Sink, stdout?: Sink): ParsedArgs;
}

/** Ported from `codex_audio/cli.py::build_parser`. */
export function buildParser(): ArgParser {
  const specsByFlag = new Map<string, OptionSpec>();
  for (const spec of OPTION_SPECS) {
    for (const flag of spec.flags) specsByFlag.set(flag, spec);
  }

  return {
    parseArgs(argv: string[], stderr: Sink = process.stderr, stdout: Sink = process.stdout): ParsedArgs {
      const result: Record<string, unknown> = { input: null };
      for (const spec of OPTION_SPECS) result[spec.dest] = spec.default;

      const positionals: string[] = [];
      const unrecognized: string[] = [];

      let i = 0;
      while (i < argv.length) {
        const tok = argv[i] as string;

        if (tok === "-h" || tok === "--help") {
          stdout.write(helpText());
          throw new ArgparseExit(0);
        }

        const looksLikeOption = tok.length > 1 && tok.startsWith("-") && !/^-\d/.test(tok);
        if (!looksLikeOption) {
          positionals.push(tok);
          i++;
          continue;
        }

        let flag = tok;
        let inlineValue: string | undefined;
        if (tok.startsWith("--")) {
          const eq = tok.indexOf("=");
          if (eq !== -1) {
            flag = tok.slice(0, eq);
            inlineValue = tok.slice(eq + 1);
          }
        }

        const spec = specsByFlag.get(flag);
        if (!spec) {
          unrecognized.push(tok);
          i++;
          continue;
        }

        if (spec.kind === "store_true") {
          result[spec.dest] = true;
          i++;
          continue;
        }

        let raw: string;
        if (inlineValue !== undefined) {
          raw = inlineValue;
          i++;
        } else {
          const next = argv[i + 1];
          if (next === undefined) {
            argError(stderr, `argument ${primaryFlagName(spec)}: expected one argument`);
          }
          raw = next;
          i += 2;
        }

        switch (spec.kind) {
          case "string": {
            result[spec.dest] = raw;
            break;
          }
          case "choice": {
            if (!spec.choices?.includes(raw)) {
              const choiceList = (spec.choices ?? []).map((c) => `'${c}'`).join(", ");
              argError(
                stderr,
                `argument ${primaryFlagName(spec)}: invalid choice: '${raw}' (choose from ${choiceList})`,
              );
            }
            result[spec.dest] = raw;
            break;
          }
          case "int": {
            const n = pyInt(raw);
            if (n === null) {
              argError(stderr, `argument ${primaryFlagName(spec)}: invalid int value: '${raw}'`);
            }
            result[spec.dest] = n;
            break;
          }
          case "float": {
            let n: number;
            try {
              n = pyFloat(raw);
            } catch {
              argError(stderr, `argument ${primaryFlagName(spec)}: invalid float value: '${raw}'`);
            }
            result[spec.dest] = n;
            break;
          }
        }
      }

      if (positionals.length > 0) {
        result.input = positionals[0];
      }
      const extra = [...positionals.slice(1), ...unrecognized];
      if (extra.length > 0) {
        argError(stderr, `unrecognized arguments: ${extra.join(" ")}`);
      }

      return result as unknown as ParsedArgs;
    },
  };
}

/** Convenience wrapper matching Python's `build_parser().parse_args(argv)`. */
export function parseArgs(argv: string[], stderr: Sink = process.stderr, stdout: Sink = process.stdout): ParsedArgs {
  return buildParser().parseArgs(argv, stderr, stdout);
}

// ------------------------------------------------------------------ main

/**
 * Sentinel used the same way Python's `except KeyboardInterrupt: return 130`
 * is — but as a JS exception a dependency can deliberately throw, since
 * there's no direct language-level analogue of Python's KeyboardInterrupt
 * arriving mid-`await`.
 *
 * A real Ctrl+C at the terminal is handled differently and does NOT go
 * through this class or through `main()`'s return value at all: neither
 * `recordMicrophone()` (audio.ts) nor this file installs a `SIGINT`
 * listener, so Node/Bun's default behaviour applies — the process is
 * terminated by the signal immediately, and the owning shell reports the
 * conventional 128+SIGINT = 130 exit code on its own. That matches the
 * Python's real-world outcome (a genuine KeyboardInterrupt from a live
 * terminal) without this file having to intercept the signal itself. This
 * class exists purely so the *documented contract* ("main() returns 130 on
 * KeyboardInterrupt/SIGINT") is directly unit-testable: a test can make an
 * injected dependency throw `new KeyboardInterrupt()` to simulate the
 * interrupt arriving mid-await, without a real terminal or process signal.
 */
export class KeyboardInterrupt extends Error {
  constructor() {
    super("Interrupted");
    this.name = "KeyboardInterrupt";
  }
}

function errorTypeName(e: unknown): string {
  if (e instanceof Error) return e.name;
  return typeof e;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Ported from `codex_audio/cli.py::main`. Returns the process exit code. */
export async function main(argv?: string[], deps: CliDeps = {}): Promise<number> {
  const resolved = resolveDeps(deps);
  const rawArgv = argv ?? process.argv.slice(2);

  let args: ParsedArgs;
  try {
    args = parseArgs(rawArgv, resolved.stderr, resolved.stdout);
  } catch (e) {
    if (e instanceof ArgparseExit) return e.code;
    throw e;
  }

  if (args.list_devices) {
    resolved.stdout.write(`${resolved.listDevices()}\n`);
    return 0;
  }

  // Python: `if args.device and args.device.isdigit(): args.device = int(args.device)`
  if (pyTruthy(args.device) && typeof args.device === "string" && /^\d+$/.test(args.device)) {
    args = { ...args, device: Number(args.device) };
  }

  if (args.stream) {
    _err("--stream is unavailable: the Codex Desktop upload route returns one final transcript.", resolved.stderr);
    return 2;
  }

  let text: string;
  try {
    const runner = args.input ? fileMain : micMain;
    text = await runner(args, deps);
  } catch (e) {
    if (e instanceof KeyboardInterrupt) return 130;
    _err(`error: ${errorTypeName(e)}: ${errorMessage(e)}`, resolved.stderr);
    return 1;
  }

  if (args.json) {
    resolved.stdout.write(`${JSON.stringify({ text })}\n`);
  } else {
    resolved.stdout.write(`${text}\n`);
  }
  return 0;
}

// ------------------------------------------------------------------ bootstrap

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
