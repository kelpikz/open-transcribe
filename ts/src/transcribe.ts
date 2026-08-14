/**
 * Speech-to-text through the upload route used by Codex Desktop.
 *
 * Ported from `codex_audio/transcribe.py`. This is the *working* route: POST
 * one complete recording as multipart to `{base}/transcribe`, get one final
 * transcript back. No streaming, no partials, no protocol events — see
 * PORTING.md for why this (and not the WebRTC realtime endpoint) is what
 * `cli.ts` uses.
 *
 * Runtime-agnostic: only global `fetch`, `FormData`, `Blob`, and `node:fs` /
 * `node:path` are used, so this runs unchanged under Bun or Electron's Node.
 * No `Bun.*` APIs.
 *
 * The route itself is unverified end-to-end — `~/.codex/auth.json` has no
 * access token on the machine this was ported on, so nobody has exercised it
 * against the live service. Tests here stub `fetch`; never remove that stub.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { ChatGPTAuth, chatgptBaseUrl, type Clock, type FetchLike } from "./auth";
import type { TranscribeOptions, TranscriptionBackend } from "./contract";

export const TRANSCRIBE_URL_SUFFIX = "/transcribe";
export const DEFAULT_LANGUAGE = "en";
// Kept for CLI compatibility; the desktop upload route selects its service model.
export const DEFAULT_MODEL = "gpt-4o-transcribe";
export const TRANSCRIBE_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"];

/** The ChatGPT transcription service rejected or malformed a request. */
export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

// Python: a literal dict, checked before falling back to mimetypes.guess_type.
const KNOWN_CONTENT_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".webm": "audio/webm",
  ".weba": "audio/webm",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};

/**
 * Python falls back to `mimetypes.guess_type()` for extensions outside the
 * known table above, keeping the guess only if it starts with "audio/".
 * That registry is platform- and installation-dependent, so there is no
 * faithful cross-platform equivalent to call here. These two entries are
 * hardcoded from what `fixtures/content_type_for.json` recorded on the
 * machine that generated the oracle (`.opus` -> "audio/ogg", `.aiff` ->
 * "audio/aiff") — a pinned fact, not a genuine MIME guess. Any extension not
 * in either table (including ones a real `mimetypes.guess_type` might
 * resolve on some other machine) falls through to "application/octet-stream",
 * same as Python's non-"audio/" and no-guess cases both do.
 */
const GUESSED_AUDIO_CONTENT_TYPES: Record<string, string> = {
  ".opus": "audio/ogg",
  ".aiff": "audio/aiff",
};

/** Return an audio MIME type suitable for the multipart upload. */
export function contentTypeFor(p: string): string {
  // Python: Path(path).suffix.lower() — extension of the final path
  // component, lowercased; "noextension" and dotfiles with no further dot
  // (e.g. ".bashrc") both yield "".
  const suffix = path.extname(p).toLowerCase();
  const known = KNOWN_CONTENT_TYPES[suffix];
  if (known !== undefined) return known;
  const guessed = GUESSED_AUDIO_CONTENT_TYPES[suffix];
  if (guessed !== undefined) return guessed;
  return "application/octet-stream";
}

export interface TranscribeDeps {
  /**
   * Defaults to `ChatGPTAuth.load()`. Injectable so tests never read the
   * real `~/.codex/auth.json`.
   */
  authLoad?: () => ChatGPTAuth;
  /** Defaults to the global `fetch`. Injectable so tests never touch the network. */
  fetchImpl?: FetchLike;
  /**
   * Clock passed through to `ensureFresh`'s expiry check. Defaults to the
   * real clock (via `ensureFresh`'s own default) when omitted.
   */
  now?: Clock;
}

/** Upload one complete recording and return its transcript. */
export async function transcribeAudio(
  data: Uint8Array,
  options: TranscribeOptions,
  deps: TranscribeDeps = {},
): Promise<string> {
  const authLoad = deps.authLoad ?? (() => ChatGPTAuth.load());
  const fetchImpl = deps.fetchImpl ?? fetch;

  // Python: auth = ChatGPTAuth.load().ensure_fresh()
  const loaded = authLoad();
  const auth = await loaded.ensureFresh(deps.now, fetchImpl);

  const url = `${chatgptBaseUrl()}${TRANSCRIBE_URL_SUFFIX}`;

  // Python: def transcribe_audio(data, *, filename, content_type, language: str | None = "en")
  // The "en" default only substitutes when the caller omits the `language`
  // kwarg entirely; an explicit null/undefined must be forwarded as-is (and
  // then omitted below by the ordinary falsy check), exactly as
  // transcribeFile's own default already does one level up. Using
  // `options.language ?? DEFAULT_LANGUAGE` here would collapse "key absent"
  // and "key present but null/undefined" into the same case, which Python's
  // default-argument semantics do not.
  const language = Object.prototype.hasOwnProperty.call(options, "language") ? options.language : DEFAULT_LANGUAGE;
  // Python: form = {} if not language or language == "auto" else {"language": language}
  const omitLanguage = !language || language === "auto";

  const form = new FormData();
  if (!omitLanguage) {
    form.append("language", language as string);
  }
  // `data` is typed as plain `Uint8Array` in the shared contract, which
  // TypeScript now treats as `Uint8Array<ArrayBufferLike>` (could in theory
  // wrap a SharedArrayBuffer) — narrower than `Blob`'s constructor accepts.
  // Copy into a plain `ArrayBuffer`-backed view; the copy is cheap relative
  // to a network upload and sidesteps the typing mismatch without an
  // unchecked cast.
  const fileBytes: ArrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const blob = new Blob([fileBytes], { type: options.content_type });
  form.append("file", blob, options.filename);

  // Python: timeout=120 (seconds) on httpx.post. fetch has no timeout
  // option, so this approximates it with an AbortSignal instead — the
  // mechanism differs (client-side abort vs. httpx's request timeout) but
  // the effect (give up after 120s) is the same.
  const res = await fetchImpl(url, {
    method: "POST",
    headers: auth.transcriptionHeaders(),
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  if (res.status !== 200) {
    const bodyText = await res.text();
    throw new TranscriptionError(`${res.status} from ${url}: ${bodyText.slice(0, 500)}`);
  }

  // Python: try: body = response.json(); text = body["text"]
  //         except (ValueError, KeyError, TypeError) as exc: raise TranscriptionError(...) from exc
  // response.json() raising (ValueError-equivalent: malformed JSON) and
  // body["text"] raising on a non-dict body (TypeError-equivalent) or an
  // absent key (KeyError-equivalent) are the only ways this block can throw,
  // so catching everything here reproduces that breadth without narrowing it.
  let text: unknown;
  try {
    const body: unknown = await res.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError("transcription response body was not an object");
    }
    if (!("text" in body)) {
      throw new Error("transcription response body had no 'text' key");
    }
    text = (body as Record<string, unknown>).text;
  } catch {
    throw new TranscriptionError("transcription response did not contain a text field");
  }

  if (typeof text !== "string") {
    throw new TranscriptionError("transcription response text was not a string");
  }
  return text;
}

/** Read and transcribe an audio file. */
export async function transcribeFile(
  filePath: string,
  options: { language?: string | null } = {},
  deps: TranscribeDeps = {},
): Promise<string> {
  // Python: def transcribe_file(path, *, language="en") — "en" only
  // substitutes when the caller omits the kwarg entirely; an explicit
  // language=None is forwarded to transcribe_audio unchanged (and then
  // omitted there by its own falsy check). Mirror that by distinguishing
  // "key absent" from "key present with value null/undefined" rather than
  // using `options.language ?? DEFAULT_LANGUAGE`, which would collapse them.
  const language = Object.prototype.hasOwnProperty.call(options, "language") ? options.language : DEFAULT_LANGUAGE;

  const data = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  return transcribeAudio(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    { filename, content_type: contentTypeFor(filePath), language },
    deps,
  );
}

/**
 * The upload-route implementation of `TranscriptionBackend` (contract.ts).
 * Production defaults: real `ChatGPTAuth.load()` and the global `fetch`.
 */
export const uploadBackend: TranscriptionBackend = {
  transcribeAudio,
  transcribeFile,
};
