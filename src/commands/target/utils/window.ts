export const windowSamplesFromMs = (ms: number, sampleRate: number): number =>
	Math.max(1, Math.round((ms * sampleRate) / 1000));
