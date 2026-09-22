export const windowSamplesFromMs = (ms: number, sampleRate: number): number =>
	Math.max(1, Math.round((ms * sampleRate) / 1000));

export const holdHalfWidthOf = (peakHalfWidth: number): number => Math.floor(peakHalfWidth / 2);
