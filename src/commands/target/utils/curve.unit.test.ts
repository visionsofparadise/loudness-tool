import { describe, expect, it } from "vitest";
import { type Anchors, gainDbAt } from "./curve";

const baseAnchors = (overrides: Partial<Anchors> = {}): Anchors => ({
	floorDb: -55,
	pivotDb: -30,
	limitDb: -3,
	B: 6,
	peakGainDb: 2,
	...overrides,
});

describe("gainDbAt", () => {
	it("returns 0 below the floor anchor", () => {
		expect(gainDbAt(-100, baseAnchors())).toBe(0);
	});

	it("returns B at the pivot anchor", () => {
		expect(gainDbAt(-30, baseAnchors({ B: 6 }))).toBeCloseTo(6, 12);
	});

	it("returns peakGainDb at the limit anchor", () => {
		expect(gainDbAt(-3, baseAnchors({ peakGainDb: 2 }))).toBeCloseTo(2, 12);
	});

	it("interpolates the midpoint of the pivot-to-limit segment", () => {
		const anchors = baseAnchors({ pivotDb: -30, limitDb: -3, B: 6, peakGainDb: 2 });
		const position = (-15 - -30) / (-3 - -30);
		const expected = 6 + (2 - 6) * position;

		expect(gainDbAt(-15, anchors)).toBeCloseTo(expected, 12);
		expect(gainDbAt(-15, anchors)).toBeCloseTo(3.7778, 3);
	});

	it("returns B everywhere below pivot when floorDb is null", () => {
		const anchors = baseAnchors({ floorDb: null, B: 6 });

		for (const probe of [-100, -80, -60, -40, -31]) {
			expect(gainDbAt(probe, anchors)).toBe(6);
		}
	});

	it("is monotonic non-decreasing across an ascending pivot-to-limit segment", () => {
		const anchors = baseAnchors({ B: 2, peakGainDb: 9, pivotDb: -30, limitDb: -3 });
		let previous = -Infinity;

		for (let step = 0; step <= 50; step++) {
			const absXDb = -30 + (step / 50) * 27;
			const gain = gainDbAt(absXDb, anchors);

			expect(gain).toBeGreaterThanOrEqual(previous - 1e-12);
			previous = gain;
		}
	});

	it("is monotonic non-increasing across a descending pivot-to-limit segment", () => {
		const anchors = baseAnchors({ B: 6, peakGainDb: 2, pivotDb: -30, limitDb: -3 });
		let previous = Infinity;

		for (let step = 0; step <= 50; step++) {
			const absXDb = -30 + (step / 50) * 27;
			const gain = gainDbAt(absXDb, anchors);

			expect(gain).toBeLessThanOrEqual(previous + 1e-12);
			previous = gain;
		}
	});

	it("is C0 continuous at pivotDb", () => {
		const anchors = baseAnchors({ B: 6, peakGainDb: 2, pivotDb: -30, limitDb: -3, floorDb: -55 });
		const epsilon = 1e-6;
		const left = gainDbAt(-30 - epsilon, anchors);
		const right = gainDbAt(-30 + epsilon, anchors);

		expect(Math.abs(left - right)).toBeLessThanOrEqual(1e-3);
	});

	it("is C0 continuous at limitDb", () => {
		const anchors = baseAnchors({ B: 6, peakGainDb: 2, pivotDb: -30, limitDb: -3 });
		const epsilon = 1e-6;
		const left = gainDbAt(-3 - epsilon, anchors);
		const right = gainDbAt(-3 + epsilon, anchors);

		expect(left).toBeCloseTo(2, 5);
		expect(right).toBeCloseTo(2, 5);
		expect(Math.abs(left - right)).toBeLessThanOrEqual(1e-3);
	});

	it("brick-wall above limitDb decreases 1 dB per 1 dB of absXDb", () => {
		const anchors = baseAnchors({ B: 6, peakGainDb: 2, pivotDb: -30, limitDb: -3 });

		for (const delta of [0.1, 0.5, 1, 2, 5, 10]) {
			const absXDb = -3 + delta;
			const gainDb = gainDbAt(absXDb, anchors);

			expect(gainDb).toBeCloseTo(2 - delta, 12);
			expect(absXDb + gainDb).toBeCloseTo(-3 + 2, 12);
		}
	});

	it("interpolates the floor-to-pivot arm", () => {
		const anchors = baseAnchors({ floorDb: -50, pivotDb: -30, B: 8 });
		const position = (-40 - -50) / (-30 - -50);

		expect(gainDbAt(-40, anchors)).toBeCloseTo(position * 8, 12);
	});
});
