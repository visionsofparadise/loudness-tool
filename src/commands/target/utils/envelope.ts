import { SlidingWindowMinStream } from "../../../measurement/SlidingWindowStreams";
import { SampleFile } from "../../../utils/SampleFile";
import { createSampleCursor, pullSamples } from "./apply";
import { gainDbAt } from "./curve";
import type { Anchors } from "./curve";
import type { BidirectionalIir } from "../../../measurement/BidirectionalIir";
import type { Scratch } from "../../../utils/Scratch";

const GAIN_LUT_MIN_DB = -80;
const GAIN_LUT_MAX_DB = 40;
const GAIN_LUT_STEP_DB = 0.01;
const GAIN_LUT_INV_STEP = 1 / GAIN_LUT_STEP_DB;
const GAIN_LUT_SIZE = Math.round((GAIN_LUT_MAX_DB - GAIN_LUT_MIN_DB) / GAIN_LUT_STEP_DB) + 1;
const GAIN_LUT_STORED_SILENCE_DB = -200;

const buildGainLut = (): Float64Array => {
	const lut = new Float64Array(GAIN_LUT_SIZE);

	for (let entryIndex = 0; entryIndex < GAIN_LUT_SIZE; entryIndex++) {
		lut[entryIndex] = Math.pow(10, (GAIN_LUT_MIN_DB + entryIndex * GAIN_LUT_STEP_DB) / 20);
	}

	return lut;
};

const gainLutLerp = (lut: Float64Array, gainDb: number): number => {
	if (gainDb < GAIN_LUT_MIN_DB || gainDb >= GAIN_LUT_MAX_DB) {
		return Math.pow(10, gainDb / 20);
	}

	const position = (gainDb - GAIN_LUT_MIN_DB) * GAIN_LUT_INV_STEP;
	const lutIndex = position | 0;
	const fraction = position - lutIndex;
	const low = lut[lutIndex] ?? 0;
	const high = lut[lutIndex + 1] ?? 0;

	return low + (high - low) * fraction;
};

const streamCurveAndForwardIir = async (args: {
	detectionEnvelope: SampleFile;
	anchors: Anchors;
	iir: BidirectionalIir;
	halfWidth: number;
	forwardEnvelope: SampleFile;
	minHeldEnvelope: SampleFile;
}): Promise<void> => {
	const { detectionEnvelope, anchors, iir, halfWidth, forwardEnvelope, minHeldEnvelope } = args;
	const totalFrames = detectionEnvelope.frameCount;

	if (totalFrames === 0) {
		return;
	}

	const forwardState = { value: 0 };
	let forwardSeeded = false;
	const minStream = new SlidingWindowMinStream(halfWidth);
	const gainLut = buildGainLut();
	let consumedFrames = 0;

	for await (const windowChunk of detectionEnvelope.blocks()) {
		const chunkLength = windowChunk.length;
		const gainChunk = new Float64Array(chunkLength);

		for (let outputIndex = 0; outputIndex < chunkLength; outputIndex++) {
			const levelDb = windowChunk[outputIndex] ?? GAIN_LUT_STORED_SILENCE_DB;
			const gainDb = gainDbAt(levelDb, anchors);

			gainChunk[outputIndex] = gainLutLerp(gainLut, gainDb);
		}

		consumedFrames += chunkLength;

		const isFinal = consumedFrames >= totalFrames;
		const minHeldChunk = minStream.push(gainChunk, isFinal);

		if (minHeldChunk.length === 0) {
			continue;
		}

		await minHeldEnvelope.append(minHeldChunk, minHeldChunk.length);

		const forwardChunk = Float64Array.from(minHeldChunk);

		if (!forwardSeeded) {
			forwardState.value = forwardChunk[0] ?? 0;
			forwardSeeded = true;
		}

		iir.applyForwardPass(forwardChunk, forwardState);
		await forwardEnvelope.append(forwardChunk, forwardChunk.length);
	}
};

const applyBackwardPassOverSampleFiles = async (args: {
	source: SampleFile;
	dest: SampleFile;
	scratch: Scratch;
	iir: BidirectionalIir;
	minHeld: SampleFile;
	label: string;
}): Promise<void> => {
	const { source, dest, scratch, iir, minHeld, label } = args;
	const totalFrames = source.frameCount;

	if (totalFrames === 0) {
		return;
	}

	if (minHeld.frameCount !== totalFrames) {
		throw new Error(
			`applyBackwardPassOverSampleFiles: minHeld.frameCount (${minHeld.frameCount}) must equal source.frameCount (${totalFrames})`,
		);
	}

	const filteredReversed = await SampleFile.create(scratch, `${label}-filtered-reversed`);

	try {
		const backwardState = { value: 0 };
		let seeded = false;

		for await (const reversed of source.reverseBlocks()) {
			if (reversed.length === 0) {
				break;
			}

			if (!seeded) {
				backwardState.value = reversed[0] ?? 0;
				seeded = true;
			}

			iir.applyForwardPass(reversed, backwardState);
			await filteredReversed.append(reversed, reversed.length);
		}

		const minHeldCursor = createSampleCursor(minHeld.blocks());

		for await (const forwardOrder of filteredReversed.reverseBlocks()) {
			if (forwardOrder.length === 0) {
				break;
			}

			const minData = await pullSamples(minHeldCursor, forwardOrder.length);

			for (let sampleIndex = 0; sampleIndex < forwardOrder.length; sampleIndex++) {
				const iirValue = forwardOrder[sampleIndex] ?? 0;
				const minValue = minData[sampleIndex] ?? 0;

				forwardOrder[sampleIndex] = iirValue < minValue ? iirValue : minValue;
			}

			await dest.append(forwardOrder, forwardOrder.length);
		}
	} finally {
		await filteredReversed.close();
	}
};

export const renderEnvelope = async (args: {
	detectionEnvelope: SampleFile;
	dest: SampleFile;
	scratch: Scratch;
	anchors: Anchors;
	iir: BidirectionalIir;
	halfWidth: number;
	label: string;
}): Promise<void> => {
	const { detectionEnvelope, dest, scratch, anchors, iir, halfWidth, label } = args;
	const forwardEnvelope = await SampleFile.create(scratch, `${label}-forward`);
	const minHeldEnvelope = await SampleFile.create(scratch, `${label}-min-held`);

	try {
		await streamCurveAndForwardIir({
			detectionEnvelope,
			anchors,
			iir,
			halfWidth,
			forwardEnvelope,
			minHeldEnvelope,
		});
		await applyBackwardPassOverSampleFiles({
			source: forwardEnvelope,
			dest,
			scratch,
			iir,
			minHeld: minHeldEnvelope,
			label,
		});
	} finally {
		await forwardEnvelope.close();
		await minHeldEnvelope.close();
	}
};
