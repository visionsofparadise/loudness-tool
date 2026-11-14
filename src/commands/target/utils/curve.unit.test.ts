import { describe, expect, it } from "vitest";
import { type Anchors, gainDbAt } from "./curve";

const anchorsOf = (overrides: Partial<Anchors> = {}): Anchors => ({
	floorDb: -50,
	pivotDb: -30,
	kneeDb: -20,
	limitDb: -8,
	ceilingDb: 20,
	B: 6,
	peakGainDb: 2,
	...overrides,
});

const BODY_PEAK_DB = -40;
const BODY_LOUDNESS_DB = -20;

describe("gainDbAt", () => {
	it("scales a raise by the loudness ramp from the floor to the pivot", () => {
		const anchors = anchorsOf();

		expect(gainDbAt(-60, BODY_PEAK_DB, anchors)).toBe(0);
		expect(gainDbAt(-50, BODY_PEAK_DB, anchors)).toBe(0);
		expect(gainDbAt(-45, BODY_PEAK_DB, anchors)).toBeCloseTo(0.25 * 6, 12);
		expect(gainDbAt(-30, BODY_PEAK_DB, anchors)).toBe(6);
		expect(gainDbAt(-10, BODY_PEAK_DB, anchors)).toBe(6);
	});

	it("gives the body gain at every loudness with a null floor", () => {
		const anchors = anchorsOf({ floorDb: null });

		expect(gainDbAt(-200, BODY_PEAK_DB, anchors)).toBe(6);
		expect(gainDbAt(-45, BODY_PEAK_DB, anchors)).toBe(6);
	});

	it("moves from the body gain to the peak gain across the knee-to-limit ramp", () => {
		const anchors = anchorsOf();

		expect(gainDbAt(BODY_LOUDNESS_DB, -20, anchors)).toBe(6);
		expect(gainDbAt(BODY_LOUDNESS_DB, -14, anchors)).toBeCloseTo(4, 12);
		expect(gainDbAt(BODY_LOUDNESS_DB, -8, anchors)).toBe(2);
		expect(gainDbAt(BODY_LOUDNESS_DB, -2, anchors)).toBe(2);
	});

	it("gives the body gain at every peak level with the peak arm off", () => {
		const anchors = anchorsOf({ kneeDb: null, peakGainDb: 6 });

		expect(gainDbAt(BODY_LOUDNESS_DB, -14, anchors)).toBe(6);
		expect(gainDbAt(BODY_LOUDNESS_DB, -2, anchors)).toBe(6);
	});

	it("raises nothing under the floor and cuts uniformly there", () => {
		const raise = anchorsOf({ B: 6, peakGainDb: 6 });
		const cut = anchorsOf({ B: -9, peakGainDb: -9 });

		expect(gainDbAt(-70, BODY_PEAK_DB, raise)).toBe(0);
		expect(gainDbAt(-70, BODY_PEAK_DB, cut)).toBe(-9);
		expect(gainDbAt(-45, BODY_PEAK_DB, cut)).toBe(-9);
		expect(gainDbAt(-20, BODY_PEAK_DB, cut)).toBe(-9);
	});

	it("gives a frame under the floor with its peak at the limit min(peak gain, 0), or the cap", () => {
		expect(gainDbAt(-70, -8, anchorsOf({ B: 6, peakGainDb: 2 }))).toBe(0);
		expect(gainDbAt(-70, -8, anchorsOf({ B: 6, peakGainDb: -3 }))).toBe(-3);
		expect(gainDbAt(-70, -8, anchorsOf({ B: 6, peakGainDb: -3, ceilingDb: -12 }))).toBe(-4);
	});

	it("is continuous at the floor, pivot, knee and limit", () => {
		const anchors = anchorsOf();
		const epsilon = 1e-9;

		for (const loudnessDb of [-50, -30]) {
			expect(
				Math.abs(
					gainDbAt(loudnessDb - epsilon, BODY_PEAK_DB, anchors) -
						gainDbAt(loudnessDb + epsilon, BODY_PEAK_DB, anchors),
				),
			).toBeLessThan(1e-6);
		}

		for (const peakDb of [-20, -8]) {
			expect(
				Math.abs(
					gainDbAt(BODY_LOUDNESS_DB, peakDb - epsilon, anchors) -
						gainDbAt(BODY_LOUDNESS_DB, peakDb + epsilon, anchors),
				),
			).toBeLessThan(1e-6);
		}
	});

	it("caps the gain at the ceiling, falling 1 dB per dB of peak level", () => {
		const anchors = anchorsOf({ ceilingDb: -1 });

		expect(gainDbAt(BODY_LOUDNESS_DB, -2, anchors)).toBe(1);
		expect(gainDbAt(BODY_LOUDNESS_DB, 0, anchors)).toBe(-1);
		expect(gainDbAt(BODY_LOUDNESS_DB, 3, anchors)).toBe(-4);
	});

	it("never decreases as the body gain rises, the peak gain following the ceiling rule", () => {
		const ceilingDb = -1;
		const limitDb = -8;
		const expansionDb = 4;

		for (const loudnessDb of [-70, -45, -30, -10]) {
			for (const peakDb of [-60, -20, -14, -8, -3, 2]) {
				let previous = -Infinity;

				for (let boost = -60; boost <= 60; boost += 0.5) {
					const gainDb = gainDbAt(
						loudnessDb,
						peakDb,
						anchorsOf({
							limitDb,
							ceilingDb,
							B: boost,
							peakGainDb: Math.min(ceilingDb - limitDb, boost + expansionDb),
						}),
					);

					expect(gainDb).toBeGreaterThanOrEqual(previous);
					previous = gainDb;
				}
			}
		}
	});
});
