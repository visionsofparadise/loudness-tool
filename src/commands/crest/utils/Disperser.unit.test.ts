import { describe, expect, it } from "vitest";
import { Disperser } from "./Disperser";
import { dispersionKernelOf } from "./dispersion";

const noisy = (frameCount: number, seed: number): Float64Array => {
	let state = seed >>> 0;
	const values = new Float64Array(frameCount);

	for (let index = 0; index < frameCount; index++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		values[index] = state / 0x80000000 - 1;
	}

	return values;
};

const dispersedAt = (window: Float64Array, index: number, step: number): number => {
	const kernel = dispersionKernelOf(step);
	const halfWidth = (kernel.length - 1) / 2;
	let sum = 0;

	for (let tap = -halfWidth; tap <= halfWidth; tap++) {
		sum += (kernel[tap + halfWidth] ?? 0) * (window[index - tap] ?? 0);
	}

	return sum;
};

describe("Disperser", () => {
	const steps = [-24, -5, 0, 5, 24];
	const maxStepFrames = 24;

	it("matches the direct filter over more frames than one block carries", () => {
		const disperser = Disperser.of(steps, maxStepFrames);
		const frameCount = disperser.hopFrames * 2 + 37;
		const window = noisy(frameCount + 2 * maxStepFrames, 5);
		const targets = steps.map(() => [new Float64Array(frameCount)]);

		expect(disperser.hopFrames).toBeGreaterThan(0);
		disperser.disperse({
			window: [window],
			windowFirstFrame: -maxStepFrames,
			firstFrame: 0,
			frameCount,
			stepIndices: steps.map((_step, stepIndex) => stepIndex),
			targets,
		});

		for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
			const step = steps[stepIndex] ?? 0;

			for (const frame of [0, 1, 37, disperser.hopFrames - 1, disperser.hopFrames, frameCount - 1]) {
				expect(targets[stepIndex]?.[0]?.[frame] ?? 0).toBeCloseTo(
					dispersedAt(window, frame + maxStepFrames, step),
					12,
				);
			}
		}
	});

	it("copies the source through on the zero step", () => {
		const disperser = Disperser.of(steps, maxStepFrames);
		const frameCount = 300;
		const window = noisy(frameCount + 2 * maxStepFrames, 9);
		const targets = steps.map(() => [new Float64Array(frameCount)]);

		disperser.disperse({
			window: [window],
			windowFirstFrame: -maxStepFrames,
			firstFrame: 0,
			frameCount,
			stepIndices: [2],
			targets,
		});

		expect(Array.from(targets[2]?.[0] ?? [])).toEqual(
			Array.from(window.subarray(maxStepFrames, maxStepFrames + frameCount)),
		);
	});

	it("leaves the steps it was not asked for alone", () => {
		const disperser = Disperser.of(steps, maxStepFrames);
		const frameCount = 200;
		const window = noisy(frameCount + 2 * maxStepFrames, 13);
		const targets = steps.map(() => [new Float64Array(frameCount).fill(7)]);

		disperser.disperse({
			window: [window],
			windowFirstFrame: -maxStepFrames,
			firstFrame: 0,
			frameCount,
			stepIndices: [0],
			targets,
		});

		expect(targets[4]?.[0]?.[0] ?? 0).toBe(7);
		expect(targets[0]?.[0]?.[0] ?? 0).toBeCloseTo(dispersedAt(window, maxStepFrames, steps[0] ?? 0), 12);
	});
});
