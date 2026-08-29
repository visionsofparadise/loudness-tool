import { describe, expect, it } from "vitest";
import {
	exactHoldHalfWidthFrames,
	smoothControlTrajectory,
	trajectoryFrameRate,
	type ControlTrajectory,
} from "./trajectory";

const SAMPLE_RATE = 48_000;
const HOP_SIZE = 512;

const baseTrajectory = (
	frameCount: number,
	amountEnv: Float64Array,
	peakSampleIndex: Int32Array,
	transientMask: Float64Array,
): ControlTrajectory => {
	const identity = new Float64Array(2);
	const baseRows = Array.from({ length: frameCount }, () => Float64Array.from([0.4, -0.2]));

	return {
		rows: [],
		baseRows,
		amountEnv,
		laneCount: 2,
		identity,
		transientMask,
		peakSampleIndex,
	};
};

describe("trajectoryFrameRate / exactHoldHalfWidthFrames", () => {
	it("returns the hop-rate and a positive hold width", () => {
		expect(trajectoryFrameRate(SAMPLE_RATE, HOP_SIZE)).toBeCloseTo(SAMPLE_RATE / HOP_SIZE, 12);
		expect(exactHoldHalfWidthFrames(SAMPLE_RATE, HOP_SIZE)).toBeGreaterThanOrEqual(1);
		expect(trajectoryFrameRate(0, HOP_SIZE)).toBe(1);
		expect(exactHoldHalfWidthFrames(0, HOP_SIZE)).toBe(1);
	});
});

describe("smoothControlTrajectory", () => {
	it("holds a committed amount around the peak sample", () => {
		const frameCount = 16;
		const amountEnv = new Float64Array(frameCount);
		const peakSampleIndex = new Int32Array(frameCount);
		const transientMask = new Float64Array(frameCount);

		amountEnv[8] = 0.8;
		peakSampleIndex[8] = 8 * HOP_SIZE;

		const smoothed = smoothControlTrajectory(
			baseTrajectory(frameCount, amountEnv, peakSampleIndex, transientMask),
			0,
			trajectoryFrameRate(SAMPLE_RATE, HOP_SIZE),
			2,
			HOP_SIZE,
		);

		expect(smoothed.rows[8]?.[0]).toBeCloseTo(0.8 * 0.4, 12);
		expect(smoothed.rows[7]?.[0]).toBeCloseTo(0.8 * 0.4, 12);
		expect(smoothed.rows[9]?.[0]).toBeCloseTo(0.8 * 0.4, 12);
		expect(smoothed.rows[0]?.[0]).toBe(0);
	});

	it("pulls transients back before bidirectional spill", () => {
		const frameCount = 24;
		const amountEnv = new Float64Array(frameCount);
		const peakSampleIndex = new Int32Array(frameCount);
		const transientMask = new Float64Array(frameCount);

		amountEnv[4] = 0.8;
		peakSampleIndex[4] = 4 * HOP_SIZE;
		transientMask[4] = 1;

		const pulled = smoothControlTrajectory(
			baseTrajectory(frameCount, amountEnv, peakSampleIndex, transientMask),
			100,
			trajectoryFrameRate(SAMPLE_RATE, HOP_SIZE),
			1,
			HOP_SIZE,
		);

		transientMask[4] = 0;

		const full = smoothControlTrajectory(
			baseTrajectory(frameCount, amountEnv, peakSampleIndex, transientMask),
			100,
			trajectoryFrameRate(SAMPLE_RATE, HOP_SIZE),
			1,
			HOP_SIZE,
		);

		expect(pulled.rows[20]?.[0] ?? 0).toBeLessThan(full.rows[20]?.[0] ?? 0);
	});

	it("returns an empty row set for an empty trajectory", () => {
		const empty: ControlTrajectory = {
			rows: [],
			baseRows: [],
			amountEnv: new Float64Array(0),
			laneCount: 8,
			identity: new Float64Array(8),
			transientMask: new Float64Array(0),
			peakSampleIndex: new Int32Array(0),
		};

		expect(smoothControlTrajectory(empty, 100, 90, 2, 512).rows).toEqual([]);
	});
});
