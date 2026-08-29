import { describe, expect, it } from "vitest";
import { linearToDb } from "../../../utils/db";
import { measureFrameTruePeakDb, truePeakAbs4x } from "./objective";

describe("measureFrameTruePeakDb", () => {
	it("returns ≈ -6 dBTP for a steady 0.5 DC frame", () => {
		const resultDb = measureFrameTruePeakDb([new Float64Array(2048).fill(0.5)]);

		expect(resultDb).toBeGreaterThan(linearToDb(0.4));
		expect(resultDb).toBeLessThan(linearToDb(0.6));
	});

	it("returns the silence floor for an all-zero frame", () => {
		expect(measureFrameTruePeakDb([new Float64Array(2048)])).toBe(linearToDb(0));
	});

	it("returns the silence floor for zero channels", () => {
		expect(measureFrameTruePeakDb([])).toBe(linearToDb(0));
	});

	it("handles an empty frame without throwing", () => {
		expect(measureFrameTruePeakDb([new Float64Array(0)])).toBe(linearToDb(0));
	});

	it("successive calls do not contaminate each other", () => {
		const loud = new Float64Array(2048).fill(0.9);
		const quiet = new Float64Array(2048).fill(0.01);
		const quietAlone = measureFrameTruePeakDb([quiet]);
		const loudResult = measureFrameTruePeakDb([loud]);
		const quietAfterLoud = measureFrameTruePeakDb([quiet]);

		expect(loudResult).toBeGreaterThan(quietAfterLoud);
		expect(quietAfterLoud).toBe(quietAlone);
	});
});

describe("truePeakAbs4x", () => {
	it("includes a maximum that occurs only in the flushed FIR tail", () => {
		const input = new Float64Array([-0.08388812094926834, 0.6030386090278625, -0.7042242288589478]);

		expect(truePeakAbs4x(input)).toBeCloseTo(0.7503057227, 6);
		expect(truePeakAbs4x(new Float64Array(0))).toBe(0);
	});
});
