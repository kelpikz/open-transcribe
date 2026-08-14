"""codex-audio — speak, get text. Uses your ChatGPT subscription via Codex's login."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from .audio import list_devices, record_microphone
from .transcribe import (
    DEFAULT_LANGUAGE,
    DEFAULT_MODEL,
    TRANSCRIBE_MODELS,
    transcribe_audio,
    transcribe_file,
)


def _err(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class Renderer:
    """Draws the two transcript stages distinctly.

    Stage 1 is the in-flight guess for the segment you're speaking now: it
    rewrites itself in place on one line and is never part of the output.
    Stage 2 is a settled segment, printed once and kept.
    Both go to stderr; only the assembled final text reaches stdout.
    """

    DIM = "\x1b[2m"
    GREEN = "\x1b[32m"
    BOLD = "\x1b[1m"
    RESET = "\x1b[0m"
    CLEAR = "\r\x1b[2K"

    def __init__(self, enabled: bool, interactive: bool, color: bool) -> None:
        self.enabled = enabled
        # Rewriting one line in place only makes sense on a terminal; piped
        # output gets settled segments only, with no cursor control at all.
        self.interactive = interactive
        self.color = color
        self.buf = ""
        self.live_open = False

        # Windows pipes often hand us cp1252, which can't encode ✓ or ─.
        enc = getattr(sys.stderr, "encoding", None) or "ascii"
        try:
            "…✓─".encode(enc)
            self.g_live, self.g_ok, self.g_rule = "…", "✓", "─"
        except (UnicodeEncodeError, LookupError):
            self.g_live, self.g_ok, self.g_rule = "...", "*", "-"

    def _c(self, code: str) -> str:
        return code if self.color else ""

    def _clear(self) -> str:
        if self.interactive and self.live_open:
            self.live_open = False
            return self.CLEAR
        return ""

    def delta(self, delta: str) -> None:
        self.buf += delta
        if not (self.enabled and self.interactive):
            return
        # Keep the live line to one terminal row so it overwrites cleanly.
        text = self.buf[-110:]
        sys.stderr.write(
            f"{self.CLEAR}{self._c(self.DIM)}  {self.g_live} {text}{self._c(self.RESET)}"
        )
        sys.stderr.flush()
        self.live_open = True

    def final(self, text: str) -> None:
        self.buf = ""
        if not self.enabled:
            return
        sys.stderr.write(
            f"{self._clear()}{self._c(self.GREEN)}  {self.g_ok}{self._c(self.RESET)} {text}\n"
        )
        sys.stderr.flush()

    def status(self, msg: str) -> None:
        if not self.enabled:
            return
        sys.stderr.write(f"{self._clear()}{self._c(self.DIM)}  {msg}{self._c(self.RESET)}\n")
        sys.stderr.flush()

    def done(self) -> None:
        if not self.enabled:
            return
        rule = self.g_rule * 40
        sys.stderr.write(f"{self._clear()}{self._c(self.DIM)}{rule}{self._c(self.RESET)}\n")
        sys.stderr.flush()


def _render_final(text: str, args) -> None:
    if args.quiet:
        return
    render = Renderer(enabled=True, interactive=False, color=sys.stderr.isatty() and not args.no_color)
    render.final(text)
    render.done()


async def _mic_main(args) -> str:
    if not args.quiet:
        _err("Recording — press Enter to stop.")
    data = await record_microphone(device=args.device)
    if not args.quiet:
        _err("transcribing…")
    text = await asyncio.to_thread(
        transcribe_audio,
        data,
        filename="codex-audio.wav",
        content_type="audio/wav",
        language=None if args.language == "auto" else args.language,
    )
    _render_final(text, args)
    return text


async def _file_main(args) -> str:
    if not args.quiet:
        _err("transcribing…")
    text = await asyncio.to_thread(
        transcribe_file,
        args.input,
        language=None if args.language == "auto" else args.language,
    )
    _render_final(text, args)
    return text


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="codex-audio",
        description="Speech to text using your ChatGPT subscription (via `codex login`).",
    )
    p.add_argument("input", nargs="?", help="audio file to transcribe; omit to use the microphone")
    p.add_argument("--device", help="input device index or name (see --list-devices)")
    p.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=(
            f"compatibility option; desktop endpoint chooses the model "
            f"(default: {DEFAULT_MODEL}; known: {', '.join(TRANSCRIBE_MODELS)})"
        ),
    )
    p.add_argument("--list-devices", action="store_true", help="list audio input devices and exit")
    p.add_argument(
        "--language",
        "-l",
        default=DEFAULT_LANGUAGE,
        help=(
            f"ISO-639-1 language hint (default: {DEFAULT_LANGUAGE}). "
            "Use 'auto' to let the model detect it per segment"
        ),
    )
    p.add_argument("--prompt", help="context hint to bias spelling of names/jargon")
    p.add_argument(
        "--stream",
        action="store_true",
        help="compatibility option; upload transcription returns one final transcript",
    )
    p.add_argument(
        "--silence-ms",
        type=int,
        default=500,
        help="compatibility option; upload transcription is not streamed",
    )
    p.add_argument(
        "--noise-reduction",
        choices=["near_field", "far_field", "none"],
        default="none",
        help="compatibility option; noise reduction is selected by the desktop service",
    )
    p.add_argument("--json", action="store_true", help="emit JSON instead of plain text")
    p.add_argument("--quiet", "-q", action="store_true", help="no progress output on stderr")
    p.add_argument(
        "--no-partials", action="store_true", help="show only settled segments, not live guesses"
    )
    p.add_argument("--no-color", action="store_true", help="disable ANSI colour")
    p.add_argument("--raw-events", action="store_true", help="compatibility option; upload has no protocol events")
    p.add_argument("--session", help="compatibility option; upload has no session JSON")
    p.add_argument(
        "--drain",
        type=float,
        default=2.0,
        help="compatibility option; upload has no in-flight drain",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.list_devices:
        print(list_devices())
        return 0

    if args.device and args.device.isdigit():
        args.device = int(args.device)

    if args.stream:
        _err("--stream is unavailable: the Codex Desktop upload route returns one final transcript.")
        return 2

    try:
        runner = _file_main if args.input else _mic_main
        text = asyncio.run(runner(args))
    except KeyboardInterrupt:
        return 130
    except Exception as e:
        _err(f"error: {type(e).__name__}: {e}")
        return 1

    if args.json:
        print(json.dumps({"text": text}))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
