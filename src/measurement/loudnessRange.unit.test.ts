import { describe, expect, it } from "vitest";
import { computeLoudnessRange } from "./loudnessRange";

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
