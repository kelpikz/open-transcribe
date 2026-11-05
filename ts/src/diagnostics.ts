/**
 * The checks on the diagnostics part of the settings page. Each check says
 * what works, what does not, and how to fix it.
 */

import { spawnSync } from "node:child_process";

import { AuthError, ChatGPTAuth } from "./codex/index.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
	id: "ffmpeg" | "signin" | "microphone";
	status: CheckStatus;
	title: string;
	detail: string;
}

/** Find ffmpeg on the PATH and read its version. */
export function checkFfmpeg(run = spawnSync): Check {
	const result = run("ffmpeg", ["-version"], { encoding: "utf-8" });
	if (result.error !== undefined) {
		return {
			id: "ffmpeg",
			status: "fail",
			title: "ffmpeg is missing",
			detail: "open-transcribe needs ffmpeg to record. Install it, then restart the app.",
		};
	}
	const version = /ffmpeg version (\S+)/.exec(String(result.stdout))?.[1];
	return {
		id: "ffmpeg",
		status: "pass",
		title: "ffmpeg is installed",
		detail: version ? `Version ${version}` : "",
	};
}

/** Read the Codex sign-in, and refresh the access token if it expired. */
export async function checkSignIn(load = () => ChatGPTAuth.load()): Promise<Check> {
	let auth: ChatGPTAuth;
	try {
		auth = load();
	} catch (error) {
		return { id: "signin", status: "fail", title: "Signed out", detail: (error as Error).message };
	}
	try {
		await auth.ensureFresh();
	} catch (error) {
		if (error instanceof AuthError) {
			return { id: "signin", status: "fail", title: "The sign-in was rejected", detail: error.message };
		}
		return {
			id: "signin",
			status: "warn",
			title: "Could not reach ChatGPT",
			detail: `Check your internet connection. (${(error as Error).message})`,
		};
	}
	return {
		id: "signin",
		status: "pass",
		title: "Signed in with ChatGPT",
		detail: auth.email ?? "",
	};
}

/** Look for the selected microphone in the list of devices. */
export function checkMicrophone(names: string[], current: string | null): Check {
	if (current === null || names.length === 0) {
		return {
			id: "microphone",
			status: "fail",
			title: "No microphone was found",
			detail: "Connect a microphone. Then click Check again.",
		};
	}
	if (!names.includes(current)) {
		return {
			id: "microphone",
			status: "fail",
			title: "The microphone is not connected",
			detail: `"${current}" is not connected. Connect it, or choose a different microphone.`,
		};
	}
	return { id: "microphone", status: "pass", title: "Microphone found", detail: current };
}

/** The extra help for a microphone that does not open. */
export function microphoneHelp(platform = process.platform): string {
	switch (platform) {
		case "win32":
			return "Make sure that Windows lets apps use the microphone: Settings > Privacy & security > Microphone.";
		case "darwin":
			return "Make sure that open-transcribe has access: System Settings > Privacy & Security > Microphone.";
		default:
			return "Make sure that the microphone is not muted in the sound settings.";
	}
}
