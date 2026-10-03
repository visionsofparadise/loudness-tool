import { describe, expect, it } from "vitest";
import { decodeSample, encodeSample } from "../../../wav/utils/sampleCodec";
import { printedDbOf, quantizerOf } from "./rounding";
import type { SourceBitDepth } from "../../../wav/utils/wavFormat";

const roundTrip = (sample: number, bitDepth: SourceBitDepth): number => {
	const buffer = Buffer.alloc(8);

	encodeSample(buffer, 0, sample, bitDepth);

	return decodeSample(buffer, 0, bitDepth);
};

describe("quantizerOf", () => {
	const decodedCodesOf = (bitDepth: SourceBitDepth): Array<number> => {
		const buffer = Buffer.alloc(8);
		const decodedOf = (write: (target: Buffer) => void): number => {
			write(buffer);

			return decodeSample(buffer, 0, bitDepth);
		};
		const sweepCodes = (
			first: number,
			last: number,
			stride: number,
			write: (target: Buffer, code: number) => void,
		): Array<number> => {
			const decoded: Array<number> = [];

			for (let code = first; code <= last; code += stride) {
				decoded.push(decodedOf((target) => write(target, code)));
			}

			return [
				...decoded,
				decodedOf((target) => write(target, last)),
				decodedOf((target) => write(target, Math.floor(last / 2) + 2)),
			];
		};

		switch (bitDepth) {
			case "8":
				return sweepCodes(0, 0xff, 1, (target, code) => (target[0] = code));
			case "16":
				return sweepCodes(-0x8000, 0x7fff, 1, (target, code) => target.writeInt16LE(code, 0));
			case "24":
				return sweepCodes(-0x800000, 0x7fffff, 997, (target, code) => target.writeIntLE(code, 0, 3));
			case "32":
				return sweepCodes(-0x80000000, 0x7fffffff, 65537 * 997, (target, code) => target.writeInt32LE(code, 0));
			case "32f":
			case "64f":
				return [1, -1, 0.5, Math.fround(0.1), 0.1];
		}
	};

	it.each(["8", "16", "24", "32", "32f", "64f"] as const)(
		"returns for %s what decodeSample reads back from encodeSample's bytes",
		(bitDepth) => {
			const quantize = quantizerOf(bitDepth);
			const codes = decodedCodesOf(bitDepth);
			const halfways = codes.slice(1).map((sample, index) => (sample + (codes[index] ?? 0)) / 2);
			const sweep = Array.from({ length: 3001 }, (_, index) => -1.5 + index / 1000);

			for (const sample of [...sweep, ...codes, ...halfways, 0.1234567, -0.7654321, 1e-9, -1e-9, 3e-5]) {
				expect(quantize(sample) + 0).toBe(roundTrip(sample, bitDepth) + 0);
			}
		},
	);
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
