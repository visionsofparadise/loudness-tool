import { describe, expect, it } from "vitest";
import { preFilterCoefficients, rlbFilterCoefficients } from "./kWeighting";
import { KWeightedSquaredSum } from "./KWeightedSquaredSum";

const applyBiquad = (
	samples: ReadonlyArray<number>,
	b0: number,
	b1: number,
	b2: number,
	a1: number,
	a2: number,
): Array<number> => {
	const output = new Array<number>(samples.length);
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;

	for (let index = 0; index < samples.length; index++) {
		const x0 = samples[index] ?? 0;
		const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;

		output[index] = y0;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
	}

	return output;
};

const generateSine = (
	frequency: number,
	amplitude: number,
	sampleRate: number,
	durationSeconds: number,
): Float64Array => {
	const length = Math.floor(sampleRate * durationSeconds);
	const buffer = new Float64Array(length);

	for (let index = 0; index < length; index++) {
		buffer[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
	}

	return buffer;
};

describe("KWeightedSquaredSum", () => {
	it("matches a manual K-weight cascade on a small signal", () => {
		const sampleRate = 48000;
		const frameCount = 256;
		const input = new Float64Array(frameCount);

		for (let index = 0; index < frameCount; index++) {
			input[index] = Math.sin(0.13 * index) * 0.3 + Math.sin(0.07 * index) * 0.2;
		}

		const preFilter = preFilterCoefficients(sampleRate);
		const rlbFilter = rlbFilterCoefficients(sampleRate);
		const inputAsArray = Array.from(input);
		const preFiltered = applyBiquad(
			inputAsArray,
			preFilter.b0,
			preFilter.b1,
			preFilter.b2,
			preFilter.a1,
			preFilter.a2,
		);
		const filtered = applyBiquad(preFiltered, rlbFilter.b0, rlbFilter.b1, rlbFilter.b2, rlbFilter.a1, rlbFilter.a2);
		const accumulator = new KWeightedSquaredSum(sampleRate, 1);
		const output = new Float64Array(frameCount);

		accumulator.push([input], frameCount, output);

		for (let index = 0; index < frameCount; index++) {
			const expected = (filtered[index] ?? 0) * (filtered[index] ?? 0);

			expect(output[index]).toBeCloseTo(expected, 12);
		}
	});

	it("sums identical stereo channels to twice the mono per-frame energy", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 0.05);
		const sineCopy = Float64Array.from(sine);
		const frameCount = sine.length;
		const mono = new KWeightedSquaredSum(sampleRate, 1);
		const stereo = new KWeightedSquaredSum(sampleRate, 2);
		const monoOut = new Float64Array(frameCount);
		const stereoOut = new Float64Array(frameCount);

		mono.push([sine], frameCount, monoOut);
		stereo.push([sine, sineCopy], frameCount, stereoOut);

		for (let index = 100; index < frameCount; index++) {
			expect(stereoOut[index]).toBeCloseTo(2 * (monoOut[index] ?? 0), 12);
		}
	});

	it("chunked pushes are bit-equal to one whole push", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 1);
		const frameCount = sine.length;
		const oneShot = new KWeightedSquaredSum(sampleRate, 1);
		const oneShotOut = new Float64Array(frameCount);

		oneShot.push([sine], frameCount, oneShotOut);

		const streamed = new KWeightedSquaredSum(sampleRate, 1);
		const streamedOut = new Float64Array(frameCount);
		const chunkSize = 4096;

		for (let offset = 0; offset < frameCount; offset += chunkSize) {
			const chunkFrames = Math.min(chunkSize, frameCount - offset);
			const slice = sine.subarray(offset, offset + chunkFrames);
			const view = streamedOut.subarray(offset, offset + chunkFrames);

			streamed.push([slice], chunkFrames, view);
		}

		expect(Array.from(streamedOut)).toEqual(Array.from(oneShotOut));
	});

	it("throws when the channel count does not match", () => {
		const accumulator = new KWeightedSquaredSum(48000, 2);
		const buffer = new Float64Array(64);
		const output = new Float64Array(64);

		expect(() => accumulator.push([buffer], 64, output)).toThrow(/2/);
	});

	it("throws when a channel is shorter than frameCount", () => {
		const accumulator = new KWeightedSquaredSum(48000, 1);
		const buffer = new Float64Array(32);
		const output = new Float64Array(64);

		expect(() => accumulator.push([buffer], 64, output)).toThrow(/fewer than the requested 64/);
	});

	it("throws when the output is shorter than frameCount", () => {
		const accumulator = new KWeightedSquaredSum(48000, 1);
		const buffer = new Float64Array(64);
		const output = new Float64Array(32);

		expect(() => accumulator.push([buffer], 64, output)).toThrow(/output buffer/);
	});

	it("throws when channelCount is not positive", () => {
		expect(() => new KWeightedSquaredSum(48000, 0)).toThrow(/positive/);
	});

	it("keeps sub-Float32 squared contributions in Float64", () => {
		const sampleRate = 48000;
		const frameCount = 256;
		const input = new Float64Array(frameCount);

		for (let index = 0; index < frameCount; index++) {
			input[index] = 1e-20 * Math.sin(0.1 * index);
		}

		const accumulator = new KWeightedSquaredSum(sampleRate, 1);
		const output = new Float64Array(frameCount);

		accumulator.push([input], frameCount, output);

		let foundSubFloat32 = false;

		for (let index = 100; index < frameCount; index++) {
			const value = output[index] ?? 0;

			if (value > 0 && value < 1e-38) {
				foundSubFloat32 = true;
			}
		}

		expect(foundSubFloat32).toBe(true);
	});
});
