export const BINDING_DELTA_DB = 3;

export const BINDING_HEADROOM_MIN = 0.5;

const CREST_FLOOR = Math.SQRT2;
const CREST_CEIL = 6;

export const peakPriorityAmount = (signal: Float64Array, windowStart: number, windowLen: number): number => {
	const end = Math.min(signal.length, windowStart + windowLen);
	let peak = 0;
	let sumSquares = 0;
	let count = 0;

	for (let sample = Math.max(0, windowStart); sample < end; sample++) {
		const value = signal[sample] ?? 0;
		const absolute = value < 0 ? -value : value;

		if (absolute > peak) {
			peak = absolute;
		}

		sumSquares += value * value;
		count += 1;
	}

	if (count === 0 || peak <= 0) {
		return 0;
	}

	const rms = Math.sqrt(sumSquares / count);

	if (rms <= 0) {
		return 0;
	}

	const crest = peak / rms;
	const tNorm = Math.max(0, Math.min(1, (crest - CREST_FLOOR) / (CREST_CEIL - CREST_FLOOR)));

	return tNorm * tNorm * (3 - 2 * tNorm);
};

export const isBindingPeak = (
	frameTruePeakDb: number,
	headroom: number,
	globalTruePeakDb: number,
	isGlobalTpFrame = false,
): boolean => {
	const proximate = frameTruePeakDb >= globalTruePeakDb - BINDING_DELTA_DB;

	return headroom > BINDING_HEADROOM_MIN && (proximate || isGlobalTpFrame);
};
