import { describe, expect, it } from "vitest";
import {
	DELAY_FRAMES,
	FLUSH_FRAMES,
	HALF_BAND_TAPS,
	INTERPOLATOR_TAPS,
	TruePeakUpsampler,
	UPSAMPLE_FACTOR,
} from "./TruePeakUpsampler";

const HALF_BAND_LITERALS: ReadonlyArray<readonly [number, number]> = [
	[0, -0.00015865893617748379],
	[1, 0.00018547950713446886],
	[2, -0.00021457536136403258],
	[40, -0.004525474629766579],
	[78, -0.21204001883294932],
	[79, 0.6365642327784133],
	[80, 0.6365642327784133],
	[159, -0.00015865893617748379],
];

const INTERPOLATOR_LITERALS: ReadonlyArray<readonly [number, number]> = [
	[1, -0.0007645548686374766],
	[25, 0.12194836141003469],
	[33, 0.9718935112130203],
	[57, -0.005265687780732956],
	[28, 0.6098753923146512],
	[36, 0.6098753923146512],
	[31, 0.9718935112130203],
	[63, -0.0007645548686374766],
];

const FLUSH_OUTPUT_SAMPLES = FLUSH_FRAMES * UPSAMPLE_FACTOR;

const concatenate = (parts: ReadonlyArray<Float64Array>): Float64Array => {
	const length = parts.reduce((total, part) => total + part.length, 0);
	const output = new Float64Array(length);
	let offset = 0;

	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}

	return output;
};

const runFinite = (input: Float64Array, splitPoints: ReadonlyArray<number> = []): Float64Array => {
	const upsampler = new TruePeakUpsampler();
	const parts: Array<Float64Array> = [];
	let offset = 0;

	for (const end of [...splitPoints, input.length]) {
		const frameCount = end - offset;
		const output = new Float64Array(frameCount * UPSAMPLE_FACTOR);

		parts.push(output.slice(0, upsampler.upsample(input.subarray(offset, end), frameCount, output)));
		offset = end;
	}

	const flushOutput = new Float64Array(FLUSH_OUTPUT_SAMPLES);

	parts.push(flushOutput.slice(0, upsampler.flush(flushOutput)));

	return concatenate(parts);
};

const maxMagnitude = (values: Float64Array): number =>
	values.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);

const steadyPeakDb = (input: Float64Array): number => {
	const output = runFinite(input);
	const margin = 4 * DELAY_FRAMES * UPSAMPLE_FACTOR;

	return 20 * Math.log10(maxMagnitude(output.subarray(margin, input.length * UPSAMPLE_FACTOR - margin)));
};

describe("TruePeakUpsampler", () => {
	it.each([
		["half-band", HALF_BAND_TAPS, HALF_BAND_LITERALS],
		["interpolator", INTERPOLATOR_TAPS, INTERPOLATOR_LITERALS],
	] as const)("computes the %s taps lib.py's two_stage(160, 5, 8, 8, 6) prints", (_, taps, literals) => {
		for (const [index, expected] of literals) {
			expect(Math.abs((taps[index] ?? Number.NaN) - expected)).toBeLessThan(1e-12);
		}
	});

	it("emits the cascade of both stages' zero-stuffed convolutions as its impulse response", () => {
		const halfBand = new Float64Array(2 * HALF_BAND_TAPS.length);

		halfBand[HALF_BAND_TAPS.length] = 1;
		HALF_BAND_TAPS.forEach((tap, index) => {
			halfBand[2 * index + 1] = tap;
		});

		const stride = UPSAMPLE_FACTOR / 2;
		const expected = new Float64Array((FLUSH_FRAMES + 1) * UPSAMPLE_FACTOR);

		halfBand.forEach((first, firstIndex) => {
			INTERPOLATOR_TAPS.forEach((second, secondIndex) => {
				expected[firstIndex * stride + secondIndex] =
					(expected[firstIndex * stride + secondIndex] ?? 0) + first * second;
			});
		});

		const impulse = new Float64Array(1);

		impulse[0] = 1;

		const actual = runFinite(impulse);

		expect(actual.length).toBe(expected.length);
		expect(Math.max(...actual.map((value, index) => Math.abs(value - (expected[index] ?? 0))))).toBeLessThan(1e-12);
	});

	it("passes the input through phase 0, delayed by DELAY_FRAMES", () => {
		const input = Float64Array.from(
			{ length: 300 },
			(_, index) => Math.sin(index * 0.37) * 0.8 + Math.cos(index * 1.9) * 0.15,
		);
		const output = runFinite(input);

		for (let frame = 0; frame < input.length + FLUSH_FRAMES; frame++) {
			const source = frame - DELAY_FRAMES;
			const expected = source >= 0 && source < input.length ? (input[source] ?? 0) : 0;

			expect(Math.abs((output[frame * UPSAMPLE_FACTOR] ?? Number.NaN) - expected)).toBeLessThan(1e-12);
		}
	});

	it("reads an fs/4 tone of amplitude 0.5 at 33.75 degrees, its peak 10/16 of a sample past a frame, at -6.0206 dB", () => {
		const phase = (33.75 * Math.PI) / 180;
		const input = Float64Array.from({ length: 4000 }, (_, index) => 0.5 * Math.cos((Math.PI * index) / 2 + phase));

		expect(maxMagnitude(input)).toBeLessThan(0.42);
		expect(Math.abs(steadyPeakDb(input) + 6.0206)).toBeLessThan(0.01);
	});

	it("reads two tones of 0.25 at 0.44 and 0.48 fs peaking together half a sample between frames at -6.0206 dB", () => {
		const input = Float64Array.from({ length: 4000 }, (_, index) => {
			const time = index - 0.5;

			return 0.25 * Math.cos(2 * Math.PI * 0.48 * time) + 0.25 * Math.cos(2 * Math.PI * 0.44 * time);
		});

		expect(maxMagnitude(input)).toBeLessThan(0.45);
		expect(Math.abs(steadyPeakDb(input) + 6.0206)).toBeLessThan(0.03);
	});

	it("arbitrary block splits are identical to one whole input", () => {
		const input = Float64Array.from(
			{ length: 437 },
			(_, index) => Math.sin(index * 0.37) * 0.8 + Math.cos(index * 0.11) * 0.1,
		);
		const whole = runFinite(input);

		expect(runFinite(input, [1, 3, 8, 9, 21, 34, 200, 361])).toEqual(whole);
		expect(runFinite(input, [159, 160, 167, 168])).toEqual(whole);
	});

	it("writes into an oversized output and throws for an undersized one", () => {
		const input = new Float64Array([0.1, 0.2, 0.3]);
		const inputSamples = input.length * UPSAMPLE_FACTOR;
		const oversized = new Float64Array(inputSamples + 4).fill(Number.NaN);

		expect(new TruePeakUpsampler().upsample(input, 3, oversized)).toBe(inputSamples);
		expect(Number.isNaN(oversized[inputSamples])).toBe(true);
		expect(() => new TruePeakUpsampler().upsample(input, 3, new Float64Array(inputSamples - 1))).toThrow(
			`below the ${inputSamples} samples required`,
		);

		const flushUpsampler = new TruePeakUpsampler();
		const flushOversized = new Float64Array(FLUSH_OUTPUT_SAMPLES + 4).fill(Number.NaN);

		flushUpsampler.upsample(input, 3, new Float64Array(inputSamples));

		expect(flushUpsampler.flush(flushOversized)).toBe(FLUSH_OUTPUT_SAMPLES);
		expect(Number.isNaN(flushOversized[FLUSH_OUTPUT_SAMPLES])).toBe(true);

		const undersizedFlush = new TruePeakUpsampler();

		undersizedFlush.upsample(input, 3, new Float64Array(inputSamples));

		expect(() => undersizedFlush.flush(new Float64Array(FLUSH_OUTPUT_SAMPLES - 1))).toThrow(
			`below the ${FLUSH_OUTPUT_SAMPLES} samples required`,
		);
	});

	it("flush is idempotent and blocks more input until reset", () => {
		const upsampler = new TruePeakUpsampler();

		upsampler.upsample(new Float64Array([0.5]), 1, new Float64Array(UPSAMPLE_FACTOR));

		expect(upsampler.flush(new Float64Array(FLUSH_OUTPUT_SAMPLES))).toBe(FLUSH_OUTPUT_SAMPLES);
		expect(upsampler.flush(new Float64Array(FLUSH_OUTPUT_SAMPLES))).toBe(0);
		expect(() => upsampler.upsample(new Float64Array([0.25]), 1, new Float64Array(UPSAMPLE_FACTOR))).toThrow(
			"upsample after flush",
		);

		upsampler.reset();

		expect(() => upsampler.upsample(new Float64Array([0.25]), 1, new Float64Array(UPSAMPLE_FACTOR))).not.toThrow();
	});

	it("reset restores the complete cold finite-input result", () => {
		const input = new Float64Array([0.3, -0.2, 0.7, -0.4]);
		const reused = new TruePeakUpsampler();

		reused.upsample(new Float64Array([0.9, -0.8]), 2, new Float64Array(2 * UPSAMPLE_FACTOR));
		reused.flush(new Float64Array(FLUSH_OUTPUT_SAMPLES));
		reused.reset();

		const afterInput = new Float64Array(input.length * UPSAMPLE_FACTOR);
		const afterFlush = new Float64Array(FLUSH_OUTPUT_SAMPLES);

		reused.upsample(input, input.length, afterInput);
		reused.flush(afterFlush);

		expect(concatenate([afterInput, afterFlush])).toEqual(runFinite(input));
	});

	it("empty input returns empty output before the finite tail is drained", () => {
		const upsampler = new TruePeakUpsampler();

		expect(upsampler.upsample(new Float64Array(0), 0, new Float64Array(0))).toBe(0);
		expect(upsampler.flush(new Float64Array(FLUSH_OUTPUT_SAMPLES))).toBe(FLUSH_OUTPUT_SAMPLES);
	});
});
