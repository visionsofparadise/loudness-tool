import { SlidingWindowMeanStream, SlidingWindowMinStream } from "../../../measurement/SlidingWindowStreams";
import { gainDbAt } from "./curve";
import type { Anchors } from "./curve";
import type { SampleFile } from "../../../utils/SampleFile";

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

export const renderEnvelope = async (args: {
	detectionEnvelope: SampleFile;
	dest: SampleFile;
	anchors: Anchors;
	holdHalfWidth: number;
}): Promise<void> => {
	const { detectionEnvelope, dest, anchors, holdHalfWidth } = args;
	const totalFrames = detectionEnvelope.frameCount;

	if (totalFrames === 0) {
		return;
	}

	const minStream = new SlidingWindowMinStream(holdHalfWidth);
	const meanStream = new SlidingWindowMeanStream(holdHalfWidth);
	const gainLut = buildGainLut();
	let consumedFrames = 0;

	for await (const levelChunk of detectionEnvelope.blocks()) {
		const chunkLength = levelChunk.length;
		const gainDbChunk = new Float64Array(chunkLength);

		for (let frameIndex = 0; frameIndex < chunkLength; frameIndex++) {
			gainDbChunk[frameIndex] = gainDbAt(levelChunk[frameIndex] ?? GAIN_LUT_STORED_SILENCE_DB, anchors);
		}

		consumedFrames += chunkLength;

		const isFinal = consumedFrames >= totalFrames;
		const meanDbChunk = meanStream.push(minStream.push(gainDbChunk, isFinal), isFinal);
		const gainChunk = new Float64Array(meanDbChunk.length);

		for (let frameIndex = 0; frameIndex < meanDbChunk.length; frameIndex++) {
			gainChunk[frameIndex] = gainLutLerp(gainLut, meanDbChunk[frameIndex] ?? 0);
		}

		await dest.append(gainChunk, gainChunk.length);
	}
};
