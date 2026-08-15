/**
 * Speech-to-text through the upload route used by Codex Desktop.
 *
 * Runtime-agnostic: standard APIs only, so this runs under Node/Electron as
 * well as Bun.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import { ChatGPTAuth, chatgptBaseUrl } from "./auth.js";

export const TRANSCRIBE_URL_SUFFIX = "/transcribe";
export const DEFAULT_LANGUAGE = "en";
/** Kept for CLI compatibility; the desktop upload route selects its service model. */
export const DEFAULT_MODEL = "gpt-4o-transcribe";
export const TRANSCRIBE_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"];

const UPLOAD_TIMEOUT_MS = 120_000;

/** The ChatGPT transcription service rejected or malformed a request. */
export class TranscriptionError extends Error {
	override readonly name = "TranscriptionError";
}

/**
 * Extension → MIME type. The first block is the set the upload route expects;
 * the rest reproduce the audio types Python's `mimetypes` table resolves, so
 * no MIME database dependency is needed. Anything else is binary.
 */
const AUDIO_TYPES: Record<string, string> = {
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

	".opus": "audio/ogg",
	".aif": "audio/aiff",
	".aifc": "audio/aiff",
	".aiff": "audio/aiff",
	".au": "audio/basic",
	".snd": "audio/basic",
	".mp2": "audio/mpeg",
	".ra": "audio/x-pn-realaudio",
	".mid": "audio/midi",
	".midi": "audio/midi",
};

/** Return an audio MIME type suitable for the multipart upload. */
export function contentTypeFor(path: string): string {
	return AUDIO_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Upload one complete recording and return its transcript. */
export async function transcribeAudio(
	data: Uint8Array,
	options: { filename: string; contentType: string; language?: string | null },
): Promise<string> {
	const { filename, contentType, language = DEFAULT_LANGUAGE } = options;

	const auth = await ChatGPTAuth.load().ensureFresh();
	const url = `${chatgptBaseUrl()}${TRANSCRIBE_URL_SUFFIX}`;

	const form = new FormData();
	form.append("file", new Blob([data], { type: contentType }), filename);
	if (language && language !== "auto") {
		form.append("language", language);
	}

	const response = await fetch(url, {
		method: "POST",
		headers: auth.transcriptionHeaders(),
		body: form,
		signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
	});

	if (response.status !== 200) {
		const body = await response.text();
		throw new TranscriptionError(
			`${response.status} from ${url}: ${body.slice(0, 500)}`,
		);
	}

	let text: unknown;
	try {
		const body = (await response.json()) as Record<string, unknown>;
		text = body.text;
	} catch {
		throw new TranscriptionError(
			"transcription response did not contain a text field",
		);
	}
	if (text === undefined) {
		throw new TranscriptionError(
			"transcription response did not contain a text field",
		);
	}
	if (typeof text !== "string") {
		throw new TranscriptionError(
			"transcription response text was not a string",
		);
	}
	return text;
}

/** Read and transcribe an audio file. */
export async function transcribeFile(
	path: string,
	options: { language?: string | null } = {},
): Promise<string> {
	const { language = DEFAULT_LANGUAGE } = options;
	return await transcribeAudio(readFileSync(path), {
		filename: basename(path),
		contentType: contentTypeFor(path),
		language,
	});
}
