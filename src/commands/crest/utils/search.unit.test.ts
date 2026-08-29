import { describe, expect, it } from "vitest";
import { TruePeakUpsampler } from "../../../measurement/TruePeakUpsampler";
import { designDispersionAllpass, schroederTargetToDelay } from "./dispersion";
import { LATTICE_ORDER, MAX_REFLECTION, stepDownToReflection } from "./lattice";
import {
	GROUP_DELAY_CEILING_MS,
	SEARCH_GRID_POINTS,
	SEARCH_REFINE_ITERS,
	applyWindowAtScale,
	groupDelayLambda,
	searchBindingPeak,
	truePeakPower4x,
} from "./search";

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 2048;
const ORDER = LATTICE_ORDER;
const MAX_EVALUATIONS = 1 + SEARCH_GRID_POINTS + 2 + SEARCH_REFINE_ITERS;

const makeSinglePeakWindow = (length: number, harmonics = 40): Float64Array => {
	const out = new Float64Array(length);
	let peak = 0;
	const centre = Math.floor(length / 2);

	for (let sample = 0; sample < length; sample++) {
		let value = 0;
		const phase = (sample - centre) / length;

		for (let harmonic = 1; harmonic <= harmonics; harmonic++) {
			value += Math.cos(2 * Math.PI * harmonic * phase);
		}

		out[sample] = value;
		peak = Math.max(peak, Math.abs(value));
	}

	if (peak > 0) {
		for (let sample = 0; sample < length; sample++) {
			out[sample] = ((out[sample] ?? 0) / peak) * 0.9;
		}
	}

	return out;
};

const fitReflectionRow = (): Float64Array => {
	const halfSize = FRAME_SIZE / 2 + 1;
	const magnitude = new Float64Array(halfSize);

	for (let bin = 0; bin < halfSize; bin++) {
		magnitude[bin] = 1 + 0.5 * Math.cos((Math.PI * bin) / (halfSize - 1));
	}

	const delay = schroederTargetToDelay(magnitude, 1);
	const { denominator } = designDispersionAllpass(delay, ORDER);
	const reflection = stepDownToReflection(denominator);
	const row = new Float64Array(ORDER);

	for (let section = 0; section < ORDER; section++) {
		row[section] = reflection[section] ?? 0;
	}

	return row;
};

const truePeak4xAbs = (channelWindows: ReadonlyArray<Float64Array>, row: Float64Array, scale: number): number => {
	let maxAbs = 0;

	for (const channelWindow of channelWindows) {
		const transformed = applyWindowAtScale(channelWindow, row, scale, ORDER);
		const upsampler = new TruePeakUpsampler();
		const aligned = new Float64Array(transformed.length * 4);
		const alignedCount = upsampler.upsample(transformed, transformed.length, aligned);
		const tail = new Float64Array(44);
		const tailCount = upsampler.flush(tail);

		for (const output of [aligned.subarray(0, alignedCount), tail.subarray(0, tailCount)]) {
			for (const value of output) {
				maxAbs = Math.max(maxAbs, Math.abs(value));
			}
		}
	}

	return maxAbs;
};

const peakAbs = (signal: Float64Array): number => {
	let peak = 0;

	for (const value of signal) {
		peak = Math.max(peak, Math.abs(value));
	}

	return peak;
};

describe("groupDelayLambda", () => {
	it("λ ∈ (0,1)", () => {
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);

		expect(lambda).toBeGreaterThan(0);
		expect(lambda).toBeLessThan(1);
	});

	it("degenerate inputs ⇒ λ = 0", () => {
		expect(groupDelayLambda(SAMPLE_RATE, 0)).toBe(0);
		expect(groupDelayLambda(0, ORDER)).toBe(0);
		expect(groupDelayLambda(-1, ORDER)).toBe(0);
	});

	it("the summed cascade peak group delay does not exceed the named ceiling", () => {
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const summedPeakGroupDelaySamples = ORDER * ((1 + lambda) / (1 - lambda));
		const ceilingSamples = (GROUP_DELAY_CEILING_MS / 1000) * SAMPLE_RATE;

		expect(summedPeakGroupDelaySamples).toBeLessThanOrEqual(ceilingSamples + 1e-6);
		expect(GROUP_DELAY_CEILING_MS).toBeGreaterThanOrEqual(4);
		expect(GROUP_DELAY_CEILING_MS).toBeLessThanOrEqual(5);
	});

	it("λ scales with sample rate", () => {
		expect(groupDelayLambda(96_000, ORDER)).toBeGreaterThan(groupDelayLambda(48_000, ORDER));
	});
});

describe("searchBindingPeak", () => {
	it("reduces a synthetic single-peak window's 4× true peak", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const channelWindows = [window];
		const row = fitReflectionRow();
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const identityTp = truePeak4xAbs(channelWindows, row, 0);
		const result = searchBindingPeak(channelWindows, row, ORDER, lambda);

		expect(result.iterations).toBeGreaterThanOrEqual(1);
		expect(result.iterations).toBeLessThanOrEqual(MAX_EVALUATIONS);
		expect(result.committedPeakPower).toBeLessThanOrEqual(result.identityPeakPower + 1e-12);

		const committedTp = truePeak4xAbs(channelWindows, row, result.scale);

		expect(committedTp).toBeLessThanOrEqual(identityTp + 1e-9);
		expect(committedTp).toBeLessThan(identityTp);
	});

	it("is bit-identical across repeat runs", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const right = new Float64Array(FRAME_SIZE);

		for (let sample = 0; sample < FRAME_SIZE; sample++) {
			right[sample] = Math.sin((2 * Math.PI * 137 * sample) / SAMPLE_RATE) * 0.4;
		}

		const channelWindows = [window, right];
		const row = fitReflectionRow();
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const a = searchBindingPeak(channelWindows, row, ORDER, lambda);
		const b = searchBindingPeak(channelWindows, row, ORDER, lambda);

		expect(b.scale).toBe(a.scale);
		expect(b.committedPeakPower).toBe(a.committedPeakPower);
		expect(b.identityPeakPower).toBe(a.identityPeakPower);
		expect(b.iterations).toBe(a.iterations);
		expect(b.skippedAlreadyMet).toBe(a.skippedAlreadyMet);
	});

	it("committedPeakPower is the 4× true-peak power", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const channelWindows = [window];
		const row = fitReflectionRow();
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const result = searchBindingPeak(channelWindows, row, ORDER, lambda);
		const committedTp = truePeak4xAbs(channelWindows, row, result.scale);

		expect(result.committedPeakPower).toBeCloseTo(committedTp * committedTp, 12);
		expect(truePeakPower4x(channelWindows, row, 0, ORDER)).toBeCloseTo(result.identityPeakPower, 12);
	});

	it("skip-if-already-met returns scale 0 after one evaluation", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const result = searchBindingPeak([window], fitReflectionRow(), ORDER, groupDelayLambda(SAMPLE_RATE, ORDER), 4);

		expect(result.skippedAlreadyMet).toBe(true);
		expect(result.scale).toBe(0);
		expect(result.iterations).toBe(1);
	});

	it("the committed scale is in [0, λ]", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const row = fitReflectionRow();
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const result = searchBindingPeak([window], row, ORDER, lambda);

		expect(result.scale).toBeGreaterThanOrEqual(0);
		expect(result.scale).toBeLessThanOrEqual(lambda + 1e-12);

		for (let section = 0; section < ORDER; section++) {
			let km = result.scale * (row[section] ?? 0);

			if (km > MAX_REFLECTION) {
				km = MAX_REFLECTION;
			} else if (km < -MAX_REFLECTION) {
				km = -MAX_REFLECTION;
			}

			expect(Math.abs(km)).toBeLessThan(1);
		}
	});

	it("never raises 4× true peak on a sine", () => {
		const window = new Float64Array(FRAME_SIZE);

		for (let sample = 0; sample < FRAME_SIZE; sample++) {
			window[sample] = Math.sin((2 * Math.PI * 200 * sample) / SAMPLE_RATE) * 0.9;
		}

		const channelWindows = [window];
		const row = fitReflectionRow();
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const identityTp = truePeak4xAbs(channelWindows, row, 0);
		const result = searchBindingPeak(channelWindows, row, ORDER, lambda);

		expect(truePeak4xAbs(channelWindows, row, result.scale)).toBeLessThanOrEqual(identityTp + 1e-9);
	});

	it("the cross-channel objective uses all channels", () => {
		const left = makeSinglePeakWindow(FRAME_SIZE);
		const right = new Float64Array(FRAME_SIZE);

		for (let sample = 0; sample < FRAME_SIZE; sample++) {
			right[sample] = Math.sin((2 * Math.PI * 130 * sample) / SAMPLE_RATE) * 0.3;
		}

		const channelWindows = [left, right];
		const row = fitReflectionRow();
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);
		const identityPower = truePeakPower4x(channelWindows, row, 0, ORDER);
		const result = searchBindingPeak(channelWindows, row, ORDER, lambda);

		expect(result.identityPeakPower).toBeCloseTo(identityPower, 12);
		expect(result.committedPeakPower).toBeLessThanOrEqual(result.identityPeakPower + 1e-12);
		expect(truePeak4xAbs(channelWindows, row, result.scale)).toBeLessThanOrEqual(
			truePeak4xAbs(channelWindows, row, 0) + 1e-9,
		);
	});
});

describe("applyWindowAtScale", () => {
	it("scale = 0 is an exact M-sample delay", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const out = applyWindowAtScale(window, fitReflectionRow(), 0, ORDER);

		expect(peakAbs(out)).toBeCloseTo(peakAbs(window), 12);

		for (let sample = ORDER; sample < FRAME_SIZE; sample++) {
			expect(out[sample]).toBeCloseTo(window[sample - ORDER] ?? 0, 12);
		}
	});

	it("produces finite output across the bounded scale range", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const row = fitReflectionRow();
		const lambda = groupDelayLambda(SAMPLE_RATE, ORDER);

		for (const scale of [0, 0.25 * lambda, 0.5 * lambda, lambda - 1e-6]) {
			for (const value of applyWindowAtScale(window, row, scale, ORDER)) {
				expect(Number.isFinite(value)).toBe(true);
			}
		}
	});

	it("truePeakPower4x returns 0 for empty input", () => {
		const window = makeSinglePeakWindow(FRAME_SIZE);
		const row = fitReflectionRow();

		expect(truePeakPower4x([], row, 0, ORDER)).toBe(0);
		expect(truePeakPower4x([new Float64Array(0)], row, 0, ORDER)).toBe(0);

		const power = truePeakPower4x([window], row, 0, ORDER);
		const amp = truePeak4xAbs([window], row, 0);

		expect(power).toBeCloseTo(amp * amp, 12);
		expect(power).toBeGreaterThan(0);
	});

	it("includes a maximum that occurs only in the flushed FIR tail", () => {
		const input = new Float64Array([-0.08388812094926834, 0.6030386090278625, -0.7042242288589478]);
		const upsampler = new TruePeakUpsampler();
		const aligned = new Float64Array(input.length * 4);
		const alignedCount = upsampler.upsample(input, input.length, aligned);
		let sourceAlignedPeak = 0;

		for (let index = 0; index < alignedCount; index++) {
			sourceAlignedPeak = Math.max(sourceAlignedPeak, Math.abs(aligned[index] ?? 0));
		}

		const power = truePeakPower4x([input], new Float64Array(0), 0, 0);

		expect(power).toBeGreaterThan(sourceAlignedPeak * sourceAlignedPeak);
		expect(Math.sqrt(power)).toBeCloseTo(0.7503057227, 6);
	});
});
