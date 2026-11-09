/** Local startup measurements only. Audio stays in memory and is discarded. */
import { LiveMicrophone, audioDeviceNames, micInputArgs } from "../../ts/src/audio/index.js";
import { openRecordingMicrophone } from "../../ts/src/desktop/recording.js";
import { STARTUP_BUDGET, summarizeStartup } from "./startup-metrics.js";

if (process.platform !== "win32") throw new Error("This benchmark compares the Windows desktop capture paths.");
const device = process.argv[2] ?? audioDeviceNames()[0];
if (!device) throw new Error("No microphone was found.");

const paths = [
	{ name: "ffmpeg", open: () => LiveMicrophone.open(micInputArgs(device), { prerollMs: 0 }) },
	{ name: "desktop", open: () => openRecordingMicrophone(device) },
];
const results = new Map<string, number[]>();
for (let trial = 1; trial <= STARTUP_BUDGET.sampleCount; trial++) {
	// Alternate order to avoid giving one path all of the warm device opens.
	for (const path of trial % 2 === 1 ? paths : [...paths].reverse()) {
		const started = performance.now();
		const mic = await path.open();
		const elapsed = Math.round(performance.now() - started);
		try {
			mic.begin();
			await Bun.sleep(80);
			const pcm = mic.end();
			if (pcm.length === 0 || pcm.length % 2 !== 0) throw new Error("Capture did not return valid PCM samples.");
		} finally {
			mic.stop();
			await mic.exited;
		}
		const times = results.get(path.name) ?? [];
		times.push(elapsed);
		results.set(path.name, times);
		console.log(JSON.stringify({ trial, path: path.name, firstAudioMs: elapsed }));
	}
}
console.log(JSON.stringify({
	device,
	results: Object.fromEntries([...results].map(([name, times]) => {
		return [name, { times, ...summarizeStartup(times) }];
	})),
}));
