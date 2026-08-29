// eslint-disable-next-line comment-rules/no-restricted-comments
// Item 7 = Hong, Kim & Har 2011 §2.2/§3 Eqs. 1,5–9.

import { applyLatticeChannel, LATTICE_ORDER } from "./lattice";
import { truePeakAbs4x } from "./objective";

export const GROUP_DELAY_CEILING_MS = 4.0;

export const SEARCH_GRID_POINTS = 64;

export const SEARCH_REFINE_ITERS = 20;

const TARGET_PEAK_POWER_RATIO = 0.5;

export const groupDelayLambda = (sampleRate: number, order: number = LATTICE_ORDER): number => {
	if (order <= 0 || !(sampleRate > 0)) {
		return 0;
	}

	const ceilingSamples = (GROUP_DELAY_CEILING_MS / 1000) * sampleRate;
	const ratio = ceilingSamples / order;

	if (!(ratio > 1)) {
		return 0;
	}

	// eslint-disable-next-line comment-rules/no-restricted-comments
	// λ = (R−1)/(R+1) from Abel & Smith Eq. 4 inverted.
	return (ratio - 1) / (ratio + 1);
};

export const applyWindowAtScale = (
	window: Float64Array,
	reflectionRow: Float64Array,
	scale: number,
	order: number,
): Float64Array => applyLatticeChannel(window, reflectionRow, scale, order);

export const truePeakPower4x = (
	channelWindows: ReadonlyArray<Float64Array>,
	reflectionRow: Float64Array,
	scale: number,
	order: number,
): number => {
	let maxAbs = 0;

	for (const channelWindow of channelWindows) {
		if (channelWindow.length === 0) {
			continue;
		}

		const transformed = applyWindowAtScale(channelWindow, reflectionRow, scale, order);
		const peak = truePeakAbs4x(transformed);

		if (peak > maxAbs) {
			maxAbs = peak;
		}
	}

	// eslint-disable-next-line comment-rules/no-restricted-comments
	// |truePeak|² — a POWER, matching Hong's Eq. 5 |p̃(n_i)|² cost shape.
	return maxAbs * maxAbs;
};

export interface SearchResult {
	readonly scale: number;
	readonly iterations: number;
	readonly committedPeakPower: number;
	readonly identityPeakPower: number;
	readonly skippedAlreadyMet: boolean;
}

export const searchBindingPeak = (
	channelWindows: ReadonlyArray<Float64Array>,
	reflectionRow: Float64Array,
	order: number,
	lambda: number,
	targetPeakRatio: number = TARGET_PEAK_POWER_RATIO,
): SearchResult => {
	const identityPower = truePeakPower4x(channelWindows, reflectionRow, 0, order);
	const targetPeakPower = Math.max(0, targetPeakRatio) * identityPower;

	// eslint-disable-next-line comment-rules/no-restricted-comments
	// Hong 2011 §3 c₀=0 skip-if-already-met: fires only when identity already meets the (window-relative) target.
	if (identityPower <= targetPeakPower || lambda <= 0) {
		return {
			scale: 0,
			iterations: 1,
			committedPeakPower: identityPower,
			identityPeakPower: identityPower,
			skippedAlreadyMet: true,
		};
	}

	let bestScale = 0;
	let bestPeak = identityPower;
	let evaluations = 1;

	const evalAt = (candidate: number): number => {
		evaluations += 1;

		return truePeakPower4x(channelWindows, reflectionRow, candidate, order);
	};

	for (let gridIndex = 1; gridIndex <= SEARCH_GRID_POINTS; gridIndex++) {
		const candidate = (lambda * gridIndex) / SEARCH_GRID_POINTS;
		const power = evalAt(candidate);

		if (power < bestPeak) {
			bestPeak = power;
			bestScale = candidate;
		}
	}

	const step = lambda / SEARCH_GRID_POINTS;
	let lo = Math.max(0, bestScale - step);
	let hi = Math.min(lambda, bestScale + step);

	if (hi > lo) {
		const invPhi = (Math.sqrt(5) - 1) / 2;
		let x1 = hi - invPhi * (hi - lo);
		let x2 = lo + invPhi * (hi - lo);
		let f1 = evalAt(x1);
		let f2 = evalAt(x2);

		for (let iter = 0; iter < SEARCH_REFINE_ITERS; iter++) {
			if (f1 <= f2) {
				hi = x2;
				x2 = x1;
				f2 = f1;
				x1 = hi - invPhi * (hi - lo);
				f1 = evalAt(x1);
			} else {
				lo = x1;
				x1 = x2;
				f1 = f2;
				x2 = lo + invPhi * (hi - lo);
				f2 = evalAt(x2);
			}
		}

		const refinedScale = f1 <= f2 ? x1 : x2;
		const refinedPower = Math.min(f1, f2);

		if (refinedPower < bestPeak) {
			bestPeak = refinedPower;
			bestScale = refinedScale;
		}
	}

	return {
		scale: bestScale,
		iterations: evaluations,
		committedPeakPower: bestPeak,
		identityPeakPower: identityPower,
		skippedAlreadyMet: false,
	};
};
