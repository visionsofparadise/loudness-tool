import { describe, expect, it } from "vitest";
import { computeLoudnessRange, getLraConsideredStats } from "./loudnessRange";

describe("computeLoudnessRange", () => {
	it("returns 0 for empty and one-value series", () => {
		expect(computeLoudnessRange(new Float64Array(0))).toBe(0);
		expect(computeLoudnessRange(Float64Array.from([-30]))).toBe(0);
	});

	it("returns 0 when fewer than two values survive the gates", () => {
		expect(computeLoudnessRange(Float64Array.from([-80, -71]))).toBe(0);
		expect(computeLoudnessRange(Float64Array.from([-70.01, -60]))).toBe(0);
		expect(computeLoudnessRange(Float64Array.from([-30]))).toBe(0);
	});

	it("includes a short-term value equal to the -70 LUFS absolute gate", () => {
		expect(computeLoudnessRange(Float64Array.from([-70, -60]))).toBe(10);
	});

	it("includes a short-term value equal to the relative gate", () => {
		const boundary = -50;
		const high = boundary + 10 * Math.log10(199);

		expect(computeLoudnessRange(Float64Array.from([boundary, high]))).toBeCloseTo(high - boundary, 12);
	});

	it("excludes a short-term value just below the relative gate", () => {
		const boundary = -50;
		const high = boundary + 10 * Math.log10(199);

		expect(computeLoudnessRange(Float64Array.from([boundary - 1e-9, high]))).toBe(0);
	});

	it("uses rounded zero-based 10th and 95th percentile indices", () => {
		expect(computeLoudnessRange(Float64Array.from([-30, -29, -28, -27, -26, -25]))).toBe(4);
	});
});

describe("getLraConsideredStats", () => {
	it("returns +Infinity fields when the considered set is empty", () => {
		expect(getLraConsideredStats(new Float64Array(0))).toEqual({
			minimum: Number.POSITIVE_INFINITY,
			median: Number.POSITIVE_INFINITY,
		});
		expect(getLraConsideredStats(Float64Array.from([-80, -71]))).toEqual({
			minimum: Number.POSITIVE_INFINITY,
			median: Number.POSITIVE_INFINITY,
		});
	});

	it("returns the minimum and median of a hand-computed gated set", () => {
		expect(getLraConsideredStats(Float64Array.from([-30, -29, -28, -27]))).toEqual({
			minimum: -30,
			median: -28.5,
		});
		expect(getLraConsideredStats(Float64Array.from([-30, -29, -28]))).toEqual({
			minimum: -30,
			median: -29,
		});
	});

	it("uses the same considered set as computeLoudnessRange", () => {
		const series = Float64Array.from([-80, -70, -60, -50, -40, -30]);
		const stats = getLraConsideredStats(series);
		const range = computeLoudnessRange(series);

		expect(stats.minimum).toBeLessThan(stats.median);
		expect(range).toBeGreaterThan(0);
		expect(stats.minimum).toBeGreaterThanOrEqual(-70);
	});
});
