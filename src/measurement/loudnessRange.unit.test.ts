import { describe, expect, it } from "vitest";
import { createLevelSegments } from "../utils/testSignals";
import { computeLoudnessRange, getLraConsideredStats } from "./loudnessRange";
import { ShortTermLoudnessAccumulator } from "./ShortTermLoudnessAccumulator";

const measureLra = (channels: ReadonlyArray<Float64Array>, sampleRate: number): number => {
	const accumulator = new ShortTermLoudnessAccumulator(sampleRate, channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return computeLoudnessRange(accumulator.finalize());
};

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

describe("Tech 3342 §4 minimum requirements", () => {
	it.each([
		{ levels: [-20, -30], expected: 10, sampleRate: 48000 },
		{ levels: [-20, -15], expected: 5, sampleRate: 48000 },
		{ levels: [-40, -20], expected: 20, sampleRate: 48000 },
		{ levels: [-50, -35, -20, -35, -50], expected: 15, sampleRate: 48000 },
		{ levels: [-20, -30], expected: 10, sampleRate: 44100 },
	])("levels $levels yield $expected LU LRA at $sampleRate Hz", ({ levels, expected, sampleRate }) => {
		const channels = createLevelSegments(
			levels.map((db) => ({ seconds: 20, frequency: 1000, db })),
			sampleRate,
			2,
		);

		expect(Math.abs(measureLra(channels, sampleRate) - expected)).toBeLessThanOrEqual(1);
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
