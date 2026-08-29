import { describe, expect, it } from "vitest";
import { isPowerOfTwo } from "./powerOfTwo";

describe("isPowerOfTwo", () => {
	it.each([1, 2, 4, 8, 2048, 2 ** 20])("accepts %s", (value) => {
		expect(isPowerOfTwo(value)).toBe(true);
	});

	it.each([0, -1, 1.5, 3, 6, 6442450944, 2 ** 51 + 1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (value) => {
		expect(isPowerOfTwo(value)).toBe(false);
	});
});
