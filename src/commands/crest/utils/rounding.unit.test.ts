import { describe, expect, it } from "vitest";
import { printedDbOf } from "./rounding";

describe("printedDbOf", () => {
	it("reports a true peak at or below 1e-10 as -200", () => {
		expect(printedDbOf(0)).toBe(-200);
		expect(printedDbOf(1e-10)).toBe(-200);
		expect(printedDbOf(1e-12)).toBe(-200);
	});

	it("rounds onto the two decimals the report prints", () => {
		expect(printedDbOf(1)).toBe(0);
		expect(printedDbOf(0.5)).toBe(-6.02);
	});
});
