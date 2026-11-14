import { describe, expect, it } from "vitest";
import { dbToLinear, figureText, linearToDb, lufsOrNull, peakDbOrNull } from "./db";

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

describe("peakDbOrNull", () => {
	it("is null for a peak of 0 or a non-finite peak", () => {
		expect(peakDbOrNull(0)).toBeNull();
		expect(peakDbOrNull(Number.POSITIVE_INFINITY)).toBeNull();
		expect(peakDbOrNull(Number.NaN)).toBeNull();
	});

	it("converts any other peak without a floor", () => {
		expect(peakDbOrNull(0.5)).toBeCloseTo(-6.0206, 4);
		expect(peakDbOrNull(1e-12)).toBeCloseTo(-240, 9);
	});
});

describe("lufsOrNull", () => {
	it("is null for a non-finite loudness and the loudness otherwise", () => {
		expect(lufsOrNull(Number.NEGATIVE_INFINITY)).toBeNull();
		expect(lufsOrNull(Number.NaN)).toBeNull();
		expect(lufsOrNull(-23.5)).toBe(-23.5);
	});
});

describe("figureText", () => {
	it("prints null as n/a and a value with its digits and unit", () => {
		expect(figureText(null, 2, "dBTP")).toBe("n/a");
		expect(figureText(-23.456, 2, "LUFS")).toBe("-23.46 LUFS");
		expect(figureText(-3.25, 4, "dB")).toBe("-3.2500 dB");
	});
});
