/**
 * Shared contract for the TypeScript port.
 *
 * Every module codes against these types. Authored before the module ports
 * begin so four parallel efforts cannot invent four incompatible interfaces.
 *
 * Naming rule: where a value is compared against a fixture in `fixtures/`,
 * the TypeScript field names match the Python exactly — including
 * snake_case. Faithfulness to the oracle beats TS convention here.
 */

// ---------------------------------------------------------------- session
// Mirrors realtime.build_session(). Key insertion order matters: the Python
// emits format, noise_reduction, turn_detection, transcription (and within
// transcription: model, language, prompt). Preserve it so the serialised
// negotiation body is byte-identical.

export interface TranscriptionConfig {
  model: string;
  language?: string;
  prompt?: string;
}

export interface TurnDetection {
  type: "server_vad";
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
}

export interface NoiseReductionConfig {
  type: string;
}

export interface AudioInputConfig {
  format: { type: "audio/pcm"; rate: number };
  noise_reduction: NoiseReductionConfig | null;
  turn_detection: TurnDetection | null;
  transcription: TranscriptionConfig;
}

export interface SessionPayload {
  type: "transcription";
  audio: { input: AudioInputConfig };
}

export interface BuildSessionOptions {
  model?: string;
  /** null/empty omits the key entirely, as in Python's falsy check. */
  language?: string | null;
  prompt?: string | null;
  silence_ms?: number;
  prefix_padding_ms?: number;
  threshold?: number;
  vad?: boolean;
  noise_reduction?: string | null;
}

// ------------------------------------------------------------------- auth
/** What realtime needs from auth — nothing more, so it stays swappable. */
export interface AuthLike {
  headers(): Record<string, string>;
}

export interface StoredTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  account_id?: string | null;
  id_token?: string | null;
}

export interface AuthFile {
  OPENAI_API_KEY?: string | null;
  tokens?: StoredTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

// ----------------------------------------------------------------- events
/** Protocol events are untrusted JSON; nothing beyond `type` is guaranteed. */
export type RealtimeEvent = { type?: string; [key: string]: unknown };

export type OnDelta = (delta: string) => void;
export type OnFinal = (text: string) => void;
export type OnEvent = (event: RealtimeEvent) => void;

// ------------------------------------------------------------------ audio
/**
 * The seam that makes the future desktop app cheap.
 *
 * Bun implementation drives werift + ffmpeg. A Chromium implementation later
 * wraps getUserMedia and implements the same three members, so realtime and
 * cli need no changes.
 *
 * `track` is whatever the peer connection accepts (a werift MediaStreamTrack
 * today) — deliberately loose so the Chromium implementation can supply the
 * browser type without this file importing werift.
 */
export interface AudioSource {
  readonly track: unknown;
  /** "live" until the source is exhausted or stopped; then "ended". */
  readonly readyState: string;
  stop(): void;
}

// -------------------------------------------------------------------- cli
/**
 * Result of argument parsing. Keys are argparse's snake_case attribute names
 * so this compares directly against `fixtures/args_ok.json`.
 *
 * Note `device` is still a string here: main() converts an all-digit value to
 * a number *after* parsing, exactly as the Python does.
 */
export interface ParsedArgs {
  input: string | null;
  device: string | number | null;
  model: string;
  list_devices: boolean;
  language: string;
  prompt: string | null;
  stream: boolean;
  silence_ms: number;
  noise_reduction: string;
  json: boolean;
  quiet: boolean;
  no_partials: boolean;
  no_color: boolean;
  raw_events: boolean;
  session: string | null;
  drain: number;
}
