import { describe, expect, it } from "vitest";
import { holdHalfWidthOf, windowSamplesFromMs } from "./window";

describe("windowSamplesFromMs", () => {
	it("rounds milliseconds onto samples with a floor of 1", () => {
		expect(windowSamplesFromMs(1, 48000)).toBe(48);
		expect(windowSamplesFromMs(0.01, 48000)).toBe(1);
		expect(windowSamplesFromMs(10, 44100)).toBe(441);
	});
});

describe("holdHalfWidthOf", () => {
	it("halves the peak half-width rounding down", () => {
		expect(holdHalfWidthOf(48)).toBe(24);
		expect(holdHalfWidthOf(1)).toBe(0);
		expect(holdHalfWidthOf(3)).toBe(1);
	});
});
