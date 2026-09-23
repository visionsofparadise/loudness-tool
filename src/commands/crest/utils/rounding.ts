import { linearToDb } from "../../../utils/db";
import type { WavBitDepth } from "../../../wav/utils/wavFormat";

const integerScalesOf = (bitDepth: WavBitDepth): { negative: number; positive: number } | undefined => {
	switch (bitDepth) {
		case "16":
			return { negative: 0x8000, positive: 0x7fff };
		case "24":
			return { negative: 0x800000, positive: 0x7fffff };
		case "32":
			return { negative: 0x80000000, positive: 0x7fffffff };
		case "32f":
			return undefined;
	}
};

export const quantizerOf = (bitDepth: WavBitDepth): ((sample: number) => number) => {
	const scales = integerScalesOf(bitDepth);

	if (scales === undefined) {
		return (sample) => Math.fround(sample);
	}

	const { negative, positive } = scales;

	return (sample) => {
		const clamped = Math.max(-1, Math.min(1, sample));

		return Math.round(clamped < 0 ? clamped * negative : clamped * positive) / negative;
	};
};

export const printedDbOf = (amplitude: number): number => Number(linearToDb(amplitude).toFixed(2));
