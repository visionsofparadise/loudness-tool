import { describe, expect, it } from "vitest";
import { decodeSample, encodeSample } from "../../../wav/utils/sampleCodec";
import { printedDbOf, quantizerOf } from "./rounding";
import type { WavBitDepth } from "../../../wav/utils/wavFormat";

const roundTrip = (sample: number, bitDepth: WavBitDepth): number => {
	const buffer = Buffer.alloc(8);

	encodeSample(buffer, 0, sample, bitDepth);

	return decodeSample(buffer, 0, bitDepth);
};

describe("quantizerOf", () => {
	it("returns what the writer stores and the reader decodes back", () => {
		const samples = [0, 1, -1, 1.5, -1.5, 0.5, -0.5, 0.1234567, -0.7654321, 1e-9, 3e-5];

		for (const bitDepth of ["16", "24", "32", "32f"] as const) {
			const quantize = quantizerOf(bitDepth);

			for (const sample of samples) {
				expect(quantize(sample)).toBe(roundTrip(sample, bitDepth));
			}
		}
	});
});

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
