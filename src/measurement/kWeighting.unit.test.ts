import { describe, expect, it } from "vitest";
import { preFilterCoefficients, rlbFilterCoefficients } from "./kWeighting";

const coefficientsOf = (coefficients: {
	readonly b0: number;
	readonly b1: number;
	readonly b2: number;
	readonly a1: number;
	readonly a2: number;
}): Array<number> => [coefficients.b0, coefficients.b1, coefficients.b2, coefficients.a1, coefficients.a2];

describe("preFilterCoefficients", () => {
	it("returns the BS.1770-5 Table 1 constants at 48 kHz", () => {
		expect(preFilterCoefficients(48000)).toEqual({
			b0: 1.53512485958697,
			b1: -2.69169618940638,
			b2: 1.19839281085285,
			a1: -1.69065929318241,
			a2: 0.73248077421585,
		});
	});

	it("returns finite coefficients at non-48 kHz rates", () => {
		for (const sampleRate of [44100, 96000, 22050]) {
			for (const coefficient of coefficientsOf(preFilterCoefficients(sampleRate))) {
				expect(Number.isFinite(coefficient)).toBe(true);
			}
		}
	});
});

describe("rlbFilterCoefficients", () => {
	it("returns the BS.1770-5 Table 2 constants at 48 kHz", () => {
		expect(rlbFilterCoefficients(48000)).toEqual({
			b0: 1.0,
			b1: -2.0,
			b2: 1.0,
			a1: -1.99004745483398,
			a2: 0.99007225036621,
		});
	});

	it("returns finite coefficients at non-48 kHz rates", () => {
		for (const sampleRate of [44100, 96000, 22050]) {
			for (const coefficient of coefficientsOf(rlbFilterCoefficients(sampleRate))) {
				expect(Number.isFinite(coefficient)).toBe(true);
			}
		}
	});
});
