/**
 * The Codex side: the login credentials, and the routes that spend them.
 */

export * from "./auth.js";
export * from "./transcribe.js";

// realtime.ts is legacy and declares its own DEFAULT_MODEL, DEFAULT_LANGUAGE
// and TRANSCRIBE_MODELS, so flattening it here would make those three names
// ambiguous. It keeps its own name instead, with the two classes the package
// exports lifted out beside it.
export * as realtime from "./realtime.js";
export { RealtimeTranscriber, Transcript } from "./realtime.js";
