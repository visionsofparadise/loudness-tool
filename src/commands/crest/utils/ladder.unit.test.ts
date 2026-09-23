import { describe, expect, it } from "vitest";
import { crestLayoutOf, framesFromMs, stepMagnitudesOf, stretchFrameCountOf, MINIMUM_STRETCH_FRAMES } from "./ladder";

const SAMPLE_RATE = 48000;

describe("framesFromMs", () => {
	it("rounds onto frames and applies the floor it is given", () => {
		expect(framesFromMs(4, SAMPLE_RATE, 1)).toBe(192);
		expect(framesFromMs(0.05, SAMPLE_RATE, 1)).toBe(2);
		expect(framesFromMs(0.001, SAMPLE_RATE, 1)).toBe(1);
		expect(framesFromMs(0.001, SAMPLE_RATE, 12)).toBe(12);
		expect(framesFromMs(1, SAMPLE_RATE, 12)).toBe(48);
	});
});

describe("stepMagnitudesOf", () => {
	it("takes the rungs below the spread and then the spread itself", () => {
		expect(stepMagnitudesOf(4, SAMPLE_RATE)).toEqual([2, 5, 10, 17, 24, 36, 48, 72, 96, 144, 192]);
	});

	it("keeps only the spread when no rung is below it", () => {
		expect(stepMagnitudesOf(0.05, SAMPLE_RATE)).toEqual([2]);
	});

	it("counts repeats once", () => {
		expect(stepMagnitudesOf(1, 8000)).toEqual([1, 2, 3, 4, 6, 8]);
	});

	it("keeps a spread that is not a rung", () => {
		expect(stepMagnitudesOf(0.3, SAMPLE_RATE)).toEqual([2, 5, 10, 14]);
	});
});

describe("crestLayoutOf", () => {
	it("lays the steps out in either direction around zero", () => {
		const layout = crestLayoutOf({ spreadMs: 0.1, smoothingMs: 1, sampleRate: SAMPLE_RATE, frameCount: 100 });

		expect(layout.steps).toEqual([-5, -2, 0, 2, 5]);
		expect(layout.zeroStepIndex).toBe(2);
		expect(layout.maxStepFrames).toBe(5);
	});

	it("divides the smoothing by the number of steps in one direction", () => {
		const layout = crestLayoutOf({ spreadMs: 4, smoothingMs: 100, sampleRate: SAMPLE_RATE, frameCount: 48000 });

		expect(layout.steps.length).toBe(23);
		expect(layout.stretchFrames).toBe(436);
		expect(layout.stretchCount).toBe(111);
	});

	it("cuts the last stretch at the end of the source", () => {
		const layout = crestLayoutOf({ spreadMs: 0.1, smoothingMs: 1, sampleRate: SAMPLE_RATE, frameCount: 61 });

		expect(layout.stretchFrames).toBe(24);
		expect(layout.stretchCount).toBe(3);
		expect(stretchFrameCountOf(layout, 0)).toBe(24);
		expect(stretchFrameCountOf(layout, 2)).toBe(13);
	});

	it("floors a stretch at twelve frames while a step still floors at one", () => {
		const layout = crestLayoutOf({ spreadMs: 0.01, smoothingMs: 0.01, sampleRate: SAMPLE_RATE, frameCount: 100 });

		expect(layout.steps).toEqual([-1, 0, 1]);
		expect(layout.stretchFrames).toBe(MINIMUM_STRETCH_FRAMES);
		expect(
			crestLayoutOf({ spreadMs: 4, smoothingMs: 1, sampleRate: SAMPLE_RATE, frameCount: 100 }).stretchFrames,
		).toBe(12);
	});
});
