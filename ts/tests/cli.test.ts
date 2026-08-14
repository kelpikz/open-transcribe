/**
 * Mirrors tests_py/test_cli.py for ts/src/cli.ts.
 *
 * Run with `bun test` from `ts/`. Nothing here touches the network, the real
 * ~/.codex/auth.json, or a real microphone/terminal: main()/micMain()/
 * fileMain() always receive a `CliDeps` stub for the backend, mic capture,
 * device listing, and stdio.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ParsedArgs, TranscribeOptions, TranscriptionBackend } from "../src/contract";
import {
  ArgparseExit,
  KeyboardInterrupt,
  Renderer,
  _err,
  buildParser,
  canEncode,
  detectStderrEncoding,
  fileMain,
  main,
  micMain,
  parseArgs,
  renderFinal,
} from "../src/cli";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "..", "fixtures");

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf-8")) as T;
}

/** A Sink that records every write() call, concatenated in order. */
class CapturingSink {
  private chunks: string[] = [];
  write(s: string): void {
    this.chunks.push(s);
  }
  get value(): string {
    return this.chunks.join("");
  }
}

// ------------------------------------------------------------------- Renderer

type RendererOp = ["delta" | "final" | "status" | "done", string | null];

interface RendererFixtureCase {
  mode: string;
  script: string;
  ops: RendererOp[];
  glyphs: [string, string, string];
  buf_after: string;
  stderr: string;
}

const MODE_CONFIG: Record<string, { enabled: boolean; interactive: boolean; color: boolean; encoding: string }> = {
  "tty-color": { enabled: true, interactive: true, color: true, encoding: "utf-8" },
  "tty-nocolor": { enabled: true, interactive: true, color: false, encoding: "utf-8" },
  piped: { enabled: true, interactive: false, color: false, encoding: "utf-8" },
  quiet: { enabled: false, interactive: true, color: true, encoding: "utf-8" },
  "cp1252-glyph-fallback": { enabled: true, interactive: true, color: true, encoding: "cp1252" },
  "ascii-glyph-fallback": { enabled: true, interactive: true, color: true, encoding: "ascii" },
};

describe("Renderer matches fixtures/renderer.json byte-exact", () => {
  const fixture = loadFixture<RendererFixtureCase[]>("renderer");
  for (const c of fixture) {
    test(`${c.mode}/${c.script}`, () => {
      const mode = MODE_CONFIG[c.mode];
      if (!mode) throw new Error(`unknown fixture mode ${c.mode}`);
      const sink = new CapturingSink();
      const r = new Renderer(mode.enabled, mode.interactive, mode.color, sink, mode.encoding);

      for (const [op, arg] of c.ops) {
        if (op === "delta") r.delta(arg as string);
        else if (op === "final") r.final(arg as string);
        else if (op === "status") r.status(arg as string);
        else if (op === "done") r.done();
      }

      expect(sink.value).toBe(c.stderr);
      expect([r.gLive, r.gOk, r.gRule]).toEqual(c.glyphs);
      expect(r.buf).toBe(c.buf_after);
    });
  }
});

describe("Renderer glyph-fallback detection", () => {
  test("utf-8 gets the real glyphs", () => {
    const r = new Renderer(true, true, true, new CapturingSink(), "utf-8");
    expect([r.gLive, r.gOk, r.gRule]).toEqual(["…", "✓", "─"]);
  });

  test("cp1252 falls back (✓ and ─ are not representable, even though … is)", () => {
    const r = new Renderer(true, true, true, new CapturingSink(), "cp1252");
    expect([r.gLive, r.gOk, r.gRule]).toEqual(["...", "*", "-"]);
  });

  test("ascii falls back", () => {
    const r = new Renderer(true, true, true, new CapturingSink(), "ascii");
    expect([r.gLive, r.gOk, r.gRule]).toEqual(["...", "*", "-"]);
  });

  test("an unrecognised encoding name also falls back (mirrors Python's LookupError branch)", () => {
    const r = new Renderer(true, true, true, new CapturingSink(), "not-a-real-encoding");
    expect([r.gLive, r.gOk, r.gRule]).toEqual(["...", "*", "-"]);
  });
});

describe("canEncode", () => {
  test("… alone is cp1252-encodable (it's in the 0x80-0x9F special block)", () => {
    expect(canEncode("…", "cp1252")).toBe(true);
  });
  test("✓ is not cp1252-encodable", () => {
    expect(canEncode("✓", "cp1252")).toBe(false);
  });
  test("─ is not cp1252-encodable", () => {
    expect(canEncode("─", "cp1252")).toBe(false);
  });
  test("plain ASCII text is ascii-encodable", () => {
    expect(canEncode("hello world 123", "ascii")).toBe(true);
  });
});

// ------------------------------------------------------------- stderr encoding

describe("detectStderrEncoding", () => {
  test("non-Windows defaults to utf-8", () => {
    expect(detectStderrEncoding({}, "linux")).toBe("utf-8");
    expect(detectStderrEncoding({}, "darwin")).toBe("utf-8");
  });

  test("Windows without a unicode-friendly host env falls back to cp1252", () => {
    expect(detectStderrEncoding({}, "win32")).toBe("cp1252");
  });

  test("Windows Terminal (WT_SESSION) is treated as utf-8-capable", () => {
    expect(detectStderrEncoding({ WT_SESSION: "1" }, "win32")).toBe("utf-8");
  });

  test("VS Code's integrated terminal is treated as utf-8-capable", () => {
    expect(detectStderrEncoding({ TERM_PROGRAM: "vscode" }, "win32")).toBe("utf-8");
  });

  test("an explicit override wins regardless of platform", () => {
    expect(detectStderrEncoding({ CODEX_AUDIO_STDERR_ENCODING: "ascii" }, "linux")).toBe("ascii");
    expect(detectStderrEncoding({ CODEX_AUDIO_STDERR_ENCODING: "ascii" }, "win32")).toBe("ascii");
  });
});

// --------------------------------------------------------------------- _err

describe("_err", () => {
  test("writes the message plus a newline to the given sink", () => {
    const sink = new CapturingSink();
    _err("hello", sink);
    expect(sink.value).toBe("hello\n");
  });
});

// --------------------------------------------------------------- build_parser

describe("parseArgs matches fixtures/args_ok.json", () => {
  const fixture = loadFixture<Array<{ argv: string[]; parsed: ParsedArgs }>>("args_ok");
  for (const c of fixture) {
    test(JSON.stringify(c.argv), () => {
      const parsed = parseArgs(c.argv, new CapturingSink(), new CapturingSink());
      expect(parsed).toEqual(c.parsed);
    });
  }
});

describe("parseArgs error cases exit 2 (fixtures/args_err.json exit codes)", () => {
  // Per the porting brief: exit code fidelity is required; argparse's exact
  // message wording is not. These assert exit code 2 always, plus a loose
  // substring check that the message is on-topic, rather than byte-matching
  // `stderr_tail`.
  const fixture = loadFixture<Array<{ argv: string[]; exit_code: number; stderr_tail: string }>>("args_err");
  for (const c of fixture) {
    test(JSON.stringify(c.argv), () => {
      const sink = new CapturingSink();
      let caught: unknown;
      try {
        parseArgs(c.argv, sink, new CapturingSink());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ArgparseExit);
      expect((caught as ArgparseExit).code).toBe(c.exit_code);
      expect(sink.value).toContain("codex-audio: error:");
    });
  }
});

describe("buildParser/parseArgs additional behaviour", () => {
  test("-h/--help writes to stdout and exits 0", () => {
    const stdout = new CapturingSink();
    let caught: unknown;
    try {
      parseArgs(["--help"], new CapturingSink(), stdout);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ArgparseExit);
    expect((caught as ArgparseExit).code).toBe(0);
    expect(stdout.value).toContain("usage:");
    expect(stdout.value.length).toBeGreaterThan(0);
  });

  test("buildParser() returns a reusable parser object", () => {
    const parser = buildParser();
    expect(parser.parseArgs([]).language).toBe("en");
    expect(parser.parseArgs(["-l", "fr"]).language).toBe("fr");
  });
});

// ---------------------------------------------------------------- renderFinal

describe("renderFinal", () => {
  function baseArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
    return {
      input: null,
      device: null,
      model: "gpt-4o-transcribe",
      list_devices: false,
      language: "en",
      prompt: null,
      stream: false,
      silence_ms: 500,
      noise_reduction: "none",
      json: false,
      quiet: false,
      no_partials: false,
      no_color: false,
      raw_events: false,
      session: null,
      drain: 2.0,
      ...overrides,
    };
  }

  test("quiet suppresses all output", () => {
    const sink = new CapturingSink();
    renderFinal("hello", baseArgs({ quiet: true }), { stderr: sink });
    expect(sink.value).toBe("");
  });

  test("interactive=false always (renderFinal never emits the live-line clear sequence)", () => {
    const sink = new CapturingSink();
    renderFinal("hi there", baseArgs(), { stderr: sink, isTTY: false, encoding: "utf-8" });
    expect(sink.value).not.toContain("\x1b[2K");
    expect(sink.value).toContain("hi there");
  });

  test("color follows isTTY && !no_color", () => {
    const sink = new CapturingSink();
    renderFinal("hi", baseArgs(), { stderr: sink, isTTY: true, encoding: "utf-8" });
    expect(sink.value).toContain("\x1b[32m");
  });

  test("--no-color disables color even when isTTY is true", () => {
    const sink = new CapturingSink();
    renderFinal("hi", baseArgs({ no_color: true }), { stderr: sink, isTTY: true, encoding: "utf-8" });
    expect(sink.value).not.toContain("\x1b[32m");
  });
});

// -------------------------------------------------------------------- micMain

function baseArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    input: null,
    device: null,
    model: "gpt-4o-transcribe",
    list_devices: false,
    language: "en",
    prompt: null,
    stream: false,
    silence_ms: 500,
    noise_reduction: "none",
    json: false,
    quiet: false,
    no_partials: false,
    no_color: false,
    raw_events: false,
    session: null,
    drain: 2.0,
    ...overrides,
  };
}

function stubBackend(overrides: Partial<TranscriptionBackend> = {}): TranscriptionBackend {
  return {
    transcribeAudio: async () => "stub",
    transcribeFile: async () => "stub",
    ...overrides,
  };
}

describe("micMain", () => {
  test("uploads as codex-audio.wav / audio/wav and prints progress to stderr", async () => {
    let captured: { data?: Uint8Array; options?: TranscribeOptions } = {};
    const backend = stubBackend({
      transcribeAudio: async (data, options) => {
        captured = { data, options };
        return "mic transcript";
      },
    });
    const stderr = new CapturingSink();
    const stdout = new CapturingSink();
    let recordedDevice: unknown;
    const text = await micMain(baseArgs(), {
      backend,
      recordMicrophone: async (device) => {
        recordedDevice = device;
        return new TextEncoder().encode("WAVDATA");
      },
      stderr,
      stdout,
      isTTY: false,
    });

    expect(text).toBe("mic transcript");
    expect(captured.options?.filename).toBe("codex-audio.wav");
    expect(captured.options?.content_type).toBe("audio/wav");
    expect(captured.options?.language).toBe("en");
    expect(recordedDevice).toBe(null);
    expect(stderr.value).toContain("Recording");
    expect(stderr.value).toContain("transcribing");
    expect(stdout.value).toBe("");
  });

  test("quiet suppresses progress lines", async () => {
    const stderr = new CapturingSink();
    await micMain(baseArgs({ quiet: true }), {
      backend: stubBackend(),
      recordMicrophone: async () => new TextEncoder().encode("x"),
      stderr,
    });
    expect(stderr.value).toBe("");
  });

  test("language 'auto' becomes null before reaching the backend", async () => {
    let capturedLanguage: string | null | undefined;
    const backend = stubBackend({
      transcribeAudio: async (_data, options) => {
        capturedLanguage = options.language;
        return "x";
      },
    });
    await micMain(baseArgs({ language: "auto", quiet: true }), {
      backend,
      recordMicrophone: async () => new TextEncoder().encode("x"),
    });
    expect(capturedLanguage).toBeNull();
  });
});

// ------------------------------------------------------------------- fileMain

describe("fileMain", () => {
  test("passes input path and language, prints only 'transcribing…' to stderr", async () => {
    let captured: { path?: string; options?: { language?: string | null } } = {};
    const backend = stubBackend({
      transcribeFile: async (filePath, options) => {
        captured = { path: filePath, options };
        return "file transcript";
      },
    });
    const stderr = new CapturingSink();
    const stdout = new CapturingSink();
    const text = await fileMain(baseArgs({ input: "in.wav", language: "hi" }), { backend, stderr, stdout });

    expect(text).toBe("file transcript");
    expect(captured.path).toBe("in.wav");
    expect(captured.options?.language).toBe("hi");
    expect(stderr.value).toContain("transcribing");
    expect(stderr.value).not.toContain("Recording");
    expect(stdout.value).toBe("");
  });

  test("quiet suppresses progress", async () => {
    const stderr = new CapturingSink();
    await fileMain(baseArgs({ input: "in.wav", quiet: true }), { backend: stubBackend(), stderr });
    expect(stderr.value).toBe("");
  });

  test("language 'auto' becomes null", async () => {
    let capturedLanguage: string | null | undefined;
    const backend = stubBackend({
      transcribeFile: async (_path, options) => {
        capturedLanguage = options?.language;
        return "x";
      },
    });
    await fileMain(baseArgs({ input: "in.wav", language: "auto", quiet: true }), { backend });
    expect(capturedLanguage).toBeNull();
  });
});

// ---------------------------------------------------------------------- main

describe("main: --list-devices", () => {
  test("prints device list and returns 0 before touching transcription", async () => {
    const stdout = new CapturingSink();
    const code = await main(["--list-devices"], {
      listDevices: () => "device list here",
      recordMicrophone: async () => {
        throw new Error("should not reach transcription");
      },
      backend: stubBackend({
        transcribeFile: async () => {
          throw new Error("should not reach transcription");
        },
      }),
      stdout,
    });
    expect(code).toBe(0);
    expect(stdout.value).toBe("device list here\n");
  });

  test("wins even with --stream also passed", async () => {
    const code = await main(["--list-devices", "--stream"], {
      listDevices: () => "devices",
      stdout: new CapturingSink(),
    });
    expect(code).toBe(0);
  });
});

describe("main: --stream refusal matches fixtures/cli_stream_refusal.json", () => {
  const fixture = loadFixture<Array<{ argv: string[]; exit_code: number; stderr: string }>>("cli_stream_refusal");
  for (const c of fixture) {
    test(JSON.stringify(c.argv), async () => {
      const stderr = new CapturingSink();
      const code = await main(c.argv, {
        stderr,
        recordMicrophone: async () => {
          throw new Error("should not reach transcription or device work");
        },
        backend: stubBackend({
          transcribeFile: async () => {
            throw new Error("should not reach transcription or device work");
          },
        }),
      });
      expect(code).toBe(c.exit_code);
      expect(stderr.value).toBe(c.stderr);
    });
  }
});

describe("main: --device digit conversion", () => {
  test("an all-digit device string becomes a number before reaching recordMicrophone", async () => {
    let recordedDevice: unknown;
    const code = await main(["--device", "3", "--quiet"], {
      recordMicrophone: async (device) => {
        recordedDevice = device;
        return new TextEncoder().encode("x");
      },
      backend: stubBackend(),
      stdout: new CapturingSink(),
    });
    expect(code).toBe(0);
    expect(recordedDevice).toBe(3);
    expect(typeof recordedDevice).toBe("number");
  });

  test("a non-digit device string stays a string", async () => {
    let recordedDevice: unknown;
    const code = await main(["--device", "Microphone (Realtek)", "--quiet"], {
      recordMicrophone: async (device) => {
        recordedDevice = device;
        return new TextEncoder().encode("x");
      },
      backend: stubBackend(),
      stdout: new CapturingSink(),
    });
    expect(code).toBe(0);
    expect(recordedDevice).toBe("Microphone (Realtek)");
  });
});

describe("main: stdout/stderr separation", () => {
  test("stdout carries exactly the transcript, undecorated; stderr carries the progress UI", async () => {
    // renderFinal() also echoes the transcript to stderr as part of its
    // checkmark line (by design -- the point isn't that the text never
    // appears on stderr, it's that stdout is clean enough to redirect:
    // `codex-audio > notes.txt` must capture exactly the transcript, with
    // no ANSI escapes or progress chrome mixed in.
    const stdout = new CapturingSink();
    const stderr = new CapturingSink();
    const code = await main(["in.wav"], {
      stdout,
      stderr,
      backend: stubBackend({ transcribeFile: async () => "the transcript" }),
    });
    expect(code).toBe(0);
    expect(stdout.value).toBe("the transcript\n");
    expect(stdout.value).not.toContain("\x1b[");
    expect(stderr.value).toContain("the transcript"); // the checkmark line
  });

  test("--json emits {\"text\": ...} via JSON.stringify on stdout only", async () => {
    const stdout = new CapturingSink();
    const code = await main(["in.wav", "--quiet", "--json"], {
      stdout,
      backend: stubBackend({ transcribeFile: async () => 'hello "world"' }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.value)).toEqual({ text: 'hello "world"' });
  });
});

describe("main: exit codes", () => {
  test("returns 130 on a KeyboardInterrupt thrown by a dependency", async () => {
    const code = await main(["in.wav", "--quiet"], {
      backend: stubBackend({
        transcribeFile: async () => {
          throw new KeyboardInterrupt();
        },
      }),
    });
    expect(code).toBe(130);
  });

  test("returns 1 and prints 'error: {Name}: {message}' for any other exception", async () => {
    const stderr = new CapturingSink();
    const stdout = new CapturingSink();
    const code = await main(["in.wav", "--quiet"], {
      stderr,
      stdout,
      backend: stubBackend({
        transcribeFile: async () => {
          throw new RangeError("boom");
        },
      }),
    });
    expect(code).toBe(1);
    expect(stdout.value).toBe("");
    expect(stderr.value).toBe("error: RangeError: boom\n");
  });

  test("returns 0 on success", async () => {
    const code = await main(["in.wav", "--quiet"], {
      backend: stubBackend({ transcribeFile: async () => "x" }),
      stdout: new CapturingSink(),
    });
    expect(code).toBe(0);
  });
});

describe("main: routing", () => {
  test("routes to fileMain when input is given", async () => {
    const called: string[] = [];
    const code = await main(["in.wav", "--quiet"], {
      backend: stubBackend({
        transcribeFile: async () => {
          called.push("file");
          return "x";
        },
      }),
      recordMicrophone: async () => {
        called.push("mic");
        return new TextEncoder().encode("x");
      },
      stdout: new CapturingSink(),
    });
    expect(code).toBe(0);
    expect(called).toEqual(["file"]);
  });

  test("routes to micMain when no input is given", async () => {
    const called: string[] = [];
    const code = await main(["--quiet"], {
      backend: stubBackend({
        transcribeFile: async () => {
          called.push("file");
          return "x";
        },
        transcribeAudio: async () => {
          called.push("mic");
          return "x";
        },
      }),
      recordMicrophone: async () => new TextEncoder().encode("x"),
      stdout: new CapturingSink(),
    });
    expect(code).toBe(0);
    expect(called).toEqual(["mic"]);
  });
});

describe("main: parse errors return exit code 2 without touching transcription", () => {
  test("an invalid --noise-reduction value", async () => {
    const stderr = new CapturingSink();
    const code = await main(["--noise-reduction", "sideways"], {
      stderr,
      recordMicrophone: async () => {
        throw new Error("should not reach transcription");
      },
    });
    expect(code).toBe(2);
    expect(stderr.value).toContain("codex-audio: error:");
  });
});
