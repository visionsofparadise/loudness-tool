import { measureFrameTruePeakDb } from "./objective";

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

export interface WindowBinding {
	readonly binding: boolean;
	readonly peakIndex: number;
	readonly peakValue: number;
	readonly peakMagnitude: number;
	readonly headroom: number;
	readonly frameTruePeakDb: number;
}

export const isBindingPeak = (
	frameTruePeakDb: number,
	headroom: number,
	globalTruePeakDb: number,
	isGlobalTpFrame = false,
): boolean => {
	const proximate = frameTruePeakDb >= globalTruePeakDb - BINDING_DELTA_DB;

	return headroom > BINDING_HEADROOM_MIN && (proximate || isGlobalTpFrame);
};

export const classifyWindow = (
	channelWindows: ReadonlyArray<Float64Array>,
	globalTruePeakDb: number,
	isGlobalTpFrame = false,
): WindowBinding => {
	const length = channelWindows[0]?.length ?? 0;
	const channelCount = channelWindows.length;

	if (length === 0 || channelCount === 0) {
		return {
			binding: false,
			peakIndex: -1,
			peakValue: 0,
			peakMagnitude: 0,
			headroom: 0,
			frameTruePeakDb: measureFrameTruePeakDb([]),
		};
	}

	const sumWindow = new Float64Array(length);

	for (const channelWindow of channelWindows) {
		const limit = Math.min(length, channelWindow.length);

		for (let position = 0; position < limit; position++) {
			sumWindow[position] = (sumWindow[position] ?? 0) + (channelWindow[position] ?? 0);
		}
	}

	let peakMagnitude = 0;
	let peakIndex = 0;
	let peakValue = 0;

	for (let position = 0; position < length; position++) {
		const value = sumWindow[position] ?? 0;
		const magnitude = value < 0 ? -value : value;

		if (magnitude > peakMagnitude) {
			peakMagnitude = magnitude;
			peakIndex = position;
			peakValue = value;
		}
	}

	const headroom = peakPriorityAmount(sumWindow, 0, length);
	const frameTruePeakDb = measureFrameTruePeakDb(channelWindows);
	const binding = isBindingPeak(frameTruePeakDb, headroom, globalTruePeakDb, isGlobalTpFrame);

	return { binding, peakIndex, peakValue, peakMagnitude, headroom, frameTruePeakDb };
};
