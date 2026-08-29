import { describe, expect, it } from "vitest";
import { dbToLinear, linearToDb } from "./db";

describe("dbToLinear", () => {
	it("converts 0 dB to 1.0", () => {
		expect(dbToLinear(0)).toBe(1.0);
	});

	it("converts -20 dB to 0.1", () => {
		expect(dbToLinear(-20)).toBeCloseTo(0.1, 6);
	});

	it("converts +20 dB to 10.0", () => {
		expect(dbToLinear(20)).toBeCloseTo(10.0, 6);
	});

	it("converts -Infinity to 0", () => {
		expect(dbToLinear(-Infinity)).toBe(0);
	});
});

describe("linearToDb", () => {
	it("converts 1.0 to 0 dB", () => {
		expect(linearToDb(1.0)).toBe(0);
	});

	it("converts 0.1 to -20 dB", () => {
		expect(linearToDb(0.1)).toBeCloseTo(-20, 6);
	});

	it("converts 10.0 to +20 dB", () => {
		expect(linearToDb(10.0)).toBeCloseTo(20, 6);
	});

	it("clamps near-zero values and does not return -Infinity", () => {
		expect(linearToDb(0)).toBeGreaterThan(-Infinity);
		expect(linearToDb(1e-20)).toBeGreaterThan(-Infinity);
		expect(Number.isFinite(linearToDb(0))).toBe(true);
	});
});

describe("dB round-trip", () => {
	it("dbToLinear(linearToDb(x)) reconstructs x", () => {
		const values = [0.001, 0.01, 0.1, 0.5, 1.0, 2.0, 10.0, 100.0];

		for (const x of values) {
			expect(dbToLinear(linearToDb(x))).toBeCloseTo(x, 6);
		}
	});
});
