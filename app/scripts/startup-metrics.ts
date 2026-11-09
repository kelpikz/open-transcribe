/** Shared measurements and software startup limits, independent of microphone hardware. */
export const STARTUP_BUDGET = {
	sampleCount: 15,
	controlledAudioDelayMs: 40,
	firstOverheadMs: 200,
	medianOverheadMs: 75,
	p90OverheadMs: 150,
} as const;

export function summarizeStartup(samples: readonly number[]) {
	if (samples.length === 0 || samples.some(value => !Number.isFinite(value) || value < 0)) {
		throw new Error("Startup measurements must contain finite, nonnegative durations.");
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return {
		firstMs: samples[0]!,
		medianMs: sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
		p90Ms: sorted[Math.ceil(sorted.length * 0.9) - 1]!,
		minMs: sorted[0]!,
		maxMs: sorted[sorted.length - 1]!,
	};
}

export function startupBudgetFailures(firstAudioMs: readonly number[]) {
	const overheadMs = firstAudioMs.map(value => Math.max(0, value - STARTUP_BUDGET.controlledAudioDelayMs));
	const summary = summarizeStartup(overheadMs);
	const limits = [
		["First press", summary.firstMs, STARTUP_BUDGET.firstOverheadMs],
		["Median", summary.medianMs, STARTUP_BUDGET.medianOverheadMs],
		["90th percentile", summary.p90Ms, STARTUP_BUDGET.p90OverheadMs],
	] as const;
	return limits.filter(([, actual, limit]) => actual > limit)
		.map(([name, actual, limit]) => `${name} startup overhead ${actual.toFixed(1)} ms exceeds ${limit} ms.`);
}
