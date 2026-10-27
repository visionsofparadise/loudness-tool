import { describe, expect, it } from "vitest";
import { crestLayoutOf, stepFramesOf, stretchFrameCountOf, stretchFramesOf } from "./layout";

const SAMPLE_RATE = 48000;

describe("stepFramesOf", () => {
	it("quarters the spread per step and uses each width later then earlier", () => {
		expect(stepFramesOf({ spreadMs: 8, steps: 2, sampleRate: SAMPLE_RATE })).toEqual([384, -384, 96, -96]);
	});

	it("lists a width that rounds onto one already listed once", () => {
		expect(stepFramesOf({ spreadMs: 0.004, steps: 3, sampleRate: SAMPLE_RATE })).toEqual([1, -1]);
	});
});

describe("stretchFramesOf", () => {
	it("divides the smoothing by the weight levels and floors a stretch at twelve frames", () => {
		expect(stretchFramesOf({ smoothingMs: 100, sampleRate: SAMPLE_RATE })).toBe(480);
		expect(stretchFramesOf({ smoothingMs: 0.1, sampleRate: SAMPLE_RATE })).toBe(12);
	});
});

describe("stretchFrameCountOf", () => {
	it("cuts the last stretch at the end of the source", () => {
		const layout = crestLayoutOf({
			spreadMs: 8,
			steps: 2,
			smoothingMs: 100,
			sampleRate: SAMPLE_RATE,
			frameCount: 1000,
		});

		expect(layout.stretchCount).toBe(3);
		expect(stretchFrameCountOf(layout, 0)).toBe(480);
		expect(stretchFrameCountOf(layout, 2)).toBe(40);
	});
});
