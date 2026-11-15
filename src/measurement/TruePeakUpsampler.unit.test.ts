import { describe, expect, it } from "vitest";
import {
	DEFAULT_OVERSAMPLING,
	DELAY_FRAMES,
	FLUSH_FRAMES,
	HALF_BAND_TAPS,
	interpolatorTapsOf,
	OVERSAMPLING_FACTORS,
	TruePeakUpsampler,
	type OversamplingFactor,
} from "./TruePeakUpsampler";

const HALF_BAND_LITERALS: ReadonlyArray<readonly [number, number]> = [
	[0, -0.00015865893617748379],
	[1, 0.00018547950713446886],
	[2, -0.00021457536136403258],
	[5, 0.0003166385271786585],
	[10, -0.0005431993533972784],
	[20, -0.0012698758788900872],
	[30, -0.0025073322422440635],
	[40, -0.004525474629766579],
	[50, -0.007888177673189911],
	[60, -0.014269865878752824],
	[65, 0.02038851945705972],
	[70, -0.03246430299257262],
	[75, 0.07023707635765847],
	[77, 0.1270464905120509],
	[78, -0.21204001883294932],
	[79, 0.6365642327784133],
];

const SIXTEEN_X_INTERPOLATOR_LITERALS: ReadonlyArray<readonly [number, number]> = [
	[1, -0.0007645548686374766],
	[3, -0.004082089743532789],
	[5, -0.007574733533176416],
	[7, -0.005265687780732956],
	[9, 0.00826435744090166],
	[10, 0.018770824381993317],
	[11, 0.02983612549227662],
	[13, 0.043032256151261654],
	[15, 0.0250204370774339],
	[17, -0.03444511401397163],
	[19, -0.11312386082283409],
	[21, -0.15337662013854844],
	[23, -0.08685133278346521],
	[25, 0.12194836141003469],
	[28, 0.6098753923146512],
	[31, 0.9718935112130203],
];

const EIGHT_X_INTERPOLATOR_LITERALS: ReadonlyArray<readonly [number, number]> = [
	[1, -0.002165099394437387],
	[2, -0.006113914106979858],
	[3, -0.007585692599830534],
	[5, 0.018770824381993317],
	[6, 0.03893582682687298],
	[7, 0.03913436574796399],
	[9, -0.07430725241789403],
	[10, -0.1425447339336067],
	[11, -0.13698594597436847],
	[13, 0.272363256649556],
	[14, 0.6098753923146512],
	[15, 0.8907333057298185],
	[17, 0.8907333057298185],
	[19, 0.272363256649556],
	[21, -0.13698594597436847],
	[25, 0.03913436574796399],
	[29, -0.007585692599830534],
	[31, -0.002165099394437387],
];

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

const runFinite = (
	factor: OversamplingFactor,
	input: Float64Array,
	splitPoints: ReadonlyArray<number> = [],
): Float64Array => {
	const upsampler = new TruePeakUpsampler(factor);
	const parts: Array<Float64Array> = [];
	let offset = 0;

	for (const end of [...splitPoints, input.length]) {
		const frameCount = end - offset;
		const output = new Float64Array(frameCount * factor);

		parts.push(output.slice(0, upsampler.upsample(input.subarray(offset, end), frameCount, output)));
		offset = end;
	}

	const flushOutput = new Float64Array(FLUSH_FRAMES * factor);

	parts.push(flushOutput.slice(0, upsampler.flush(flushOutput)));

	return concatenate(parts);
};

const maxMagnitude = (values: Float64Array): number =>
	values.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);

const steadyPeakDb = (factor: OversamplingFactor, input: Float64Array): number => {
	const output = runFinite(factor, input);
	const margin = 4 * DELAY_FRAMES * factor;

	return 20 * Math.log10(maxMagnitude(output.subarray(margin, input.length * factor - margin)));
};

describe("TruePeakUpsampler", () => {
	it.each([
		["half-band", HALF_BAND_TAPS, HALF_BAND_LITERALS],
		["16x interpolator", interpolatorTapsOf(8), SIXTEEN_X_INTERPOLATOR_LITERALS],
		["8x interpolator", interpolatorTapsOf(4), EIGHT_X_INTERPOLATOR_LITERALS],
	] as const)("computes the %s taps lib.py's two_stage(160, 5, 8 or 4, 8, 6) prints", (_, taps, literals) => {
		for (const [index, expected] of literals) {
			expect(Math.abs((taps[index] ?? Number.NaN) - expected)).toBeLessThan(1e-12);
		}
	});

	it("defaults to 8x", () => {
		expect(DEFAULT_OVERSAMPLING).toBe(8);
		expect(new TruePeakUpsampler().factor).toBe(8);
	});

	it("reads a 0.4 fs tone peaking 1/16 of a sample off the 8x grid at the 8x scallop at 8x and within 0.01 dB at 16x", () => {
		const input = Float64Array.from(
			{ length: 4000 },
			(_, index) => 0.5 * Math.cos(2 * Math.PI * 0.4 * (index - 1 / 16)),
		);
		const scallopDb = 20 * Math.log10(Math.cos((2 * Math.PI * 0.4) / 16));

		expect(scallopDb).toBeLessThan(-0.1);
		expect(Math.abs(steadyPeakDb(8, input) + 6.0206 - scallopDb)).toBeLessThan(0.02);
		expect(Math.abs(steadyPeakDb(16, input) + 6.0206)).toBeLessThan(0.01);
	});

	describe.each(OVERSAMPLING_FACTORS)("at %ix", (factor) => {
		const flushOutputSamples = FLUSH_FRAMES * factor;

		it("passes the input through phase 0, delayed by DELAY_FRAMES", () => {
			const input = Float64Array.from(
				{ length: 300 },
				(_, index) => Math.sin(index * 0.37) * 0.8 + Math.cos(index * 1.9) * 0.15,
			);
			const output = runFinite(factor, input);

			for (let frame = 0; frame < input.length + FLUSH_FRAMES; frame++) {
				const source = frame - DELAY_FRAMES;
				const expected = source >= 0 && source < input.length ? (input[source] ?? 0) : 0;

				expect(Math.abs((output[frame * factor] ?? Number.NaN) - expected)).toBeLessThan(1e-12);
			}
		});

		it("reads an fs/4 tone of amplitude 0.5 at 33.75 degrees, its peak 5/8 of a sample past a frame, at -6.0206 dB", () => {
			const phase = (33.75 * Math.PI) / 180;
			const input = Float64Array.from({ length: 4000 }, (_, index) => 0.5 * Math.cos((Math.PI * index) / 2 + phase));

			expect(maxMagnitude(input)).toBeLessThan(0.42);
			expect(Math.abs(steadyPeakDb(factor, input) + 6.0206)).toBeLessThan(0.01);
		});

		it("reads two tones of 0.25 at 0.44 and 0.48 fs peaking together half a sample between frames at -6.0206 dB", () => {
			const input = Float64Array.from({ length: 4000 }, (_, index) => {
				const time = index - 0.5;

				return 0.25 * Math.cos(2 * Math.PI * 0.48 * time) + 0.25 * Math.cos(2 * Math.PI * 0.44 * time);
			});

			expect(maxMagnitude(input)).toBeLessThan(0.45);
			expect(Math.abs(steadyPeakDb(factor, input) + 6.0206)).toBeLessThan(0.03);
		});

		it("arbitrary block splits are identical to one whole input", () => {
			const input = Float64Array.from(
				{ length: 437 },
				(_, index) => Math.sin(index * 0.37) * 0.8 + Math.cos(index * 0.11) * 0.1,
			);
			const whole = runFinite(factor, input);

			expect(runFinite(factor, input, [1, 3, 8, 9, 21, 34, 200, 361])).toEqual(whole);
			expect(runFinite(factor, input, [159, 160, 167, 168])).toEqual(whole);
		});

		it("writes into an oversized output and throws for an undersized one", () => {
			const input = new Float64Array([0.1, 0.2, 0.3]);
			const inputSamples = input.length * factor;
			const oversized = new Float64Array(inputSamples + 4).fill(Number.NaN);

			expect(new TruePeakUpsampler(factor).upsample(input, 3, oversized)).toBe(inputSamples);
			expect(Number.isNaN(oversized[inputSamples])).toBe(true);
			expect(() => new TruePeakUpsampler(factor).upsample(input, 3, new Float64Array(inputSamples - 1))).toThrow(
				`below the ${inputSamples} samples required`,
			);

			const flushUpsampler = new TruePeakUpsampler(factor);
			const flushOversized = new Float64Array(flushOutputSamples + 4).fill(Number.NaN);

			flushUpsampler.upsample(input, 3, new Float64Array(inputSamples));

			expect(flushUpsampler.flush(flushOversized)).toBe(flushOutputSamples);
			expect(Number.isNaN(flushOversized[flushOutputSamples])).toBe(true);

			const undersizedFlush = new TruePeakUpsampler(factor);

			undersizedFlush.upsample(input, 3, new Float64Array(inputSamples));

			expect(() => undersizedFlush.flush(new Float64Array(flushOutputSamples - 1))).toThrow(
				`below the ${flushOutputSamples} samples required`,
			);
		});

		it("flush is idempotent and blocks more input until reset", () => {
			const upsampler = new TruePeakUpsampler(factor);

			upsampler.upsample(new Float64Array([0.5]), 1, new Float64Array(factor));

			expect(upsampler.flush(new Float64Array(flushOutputSamples))).toBe(flushOutputSamples);
			expect(upsampler.flush(new Float64Array(flushOutputSamples))).toBe(0);
			expect(() => upsampler.upsample(new Float64Array([0.25]), 1, new Float64Array(factor))).toThrow(
				"upsample after flush",
			);

			upsampler.reset();

			expect(() => upsampler.upsample(new Float64Array([0.25]), 1, new Float64Array(factor))).not.toThrow();
		});

		it("reset restores the complete cold finite-input result", () => {
			const input = new Float64Array([0.3, -0.2, 0.7, -0.4]);
			const reused = new TruePeakUpsampler(factor);

			reused.upsample(new Float64Array([0.9, -0.8]), 2, new Float64Array(2 * factor));
			reused.flush(new Float64Array(flushOutputSamples));
			reused.reset();

			const afterInput = new Float64Array(input.length * factor);
			const afterFlush = new Float64Array(flushOutputSamples);

			reused.upsample(input, input.length, afterInput);
			reused.flush(afterFlush);

			expect(concatenate([afterInput, afterFlush])).toEqual(runFinite(factor, input));
		});

		it("empty input returns empty output before the finite tail is drained", () => {
			const upsampler = new TruePeakUpsampler(factor);

			expect(upsampler.upsample(new Float64Array(0), 0, new Float64Array(0))).toBe(0);
			expect(upsampler.flush(new Float64Array(flushOutputSamples))).toBe(flushOutputSamples);
		});
	});
});
