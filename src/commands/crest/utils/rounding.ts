import { linearToDb } from "../../../utils/db";
import { integerScalesOf } from "../../../wav/utils/sampleCodec";
import type { SourceBitDepth } from "../../../wav/utils/wavFormat";

export const quantizerOf = (bitDepth: SourceBitDepth): ((sample: number) => number) => {
	if (bitDepth === "64f") {
		return (sample) => sample;
	}

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
