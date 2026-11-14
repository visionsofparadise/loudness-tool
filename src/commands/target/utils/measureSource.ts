import { channelWeightsOf } from "../../../measurement/channelWeights";
import { IntegratedLufsAccumulator } from "../../../measurement/IntegratedLufsAccumulator";
import { KWeightedSquaredSum } from "../../../measurement/KWeightedSquaredSum";
import { computeLoudnessRange, getLraConsideredStats } from "../../../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../../../measurement/ShortTermLoudnessAccumulator";
import { SlidingWindowMaxStream, SlidingWindowMeanStream } from "../../../measurement/SlidingWindowStreams";
import { DELAY_FRAMES, FLUSH_FRAMES, TruePeakUpsampler, UPSAMPLE_FACTOR } from "../../../measurement/TruePeakUpsampler";
import { linearToDb, peakDbOrNull } from "../../../utils/db";
import { SampleFile } from "../../../utils/SampleFile";
import type { Scratch } from "../../../utils/Scratch";
import type { SourceBitDepth } from "../../../wav/utils/wavFormat";
import type { BlockSource } from "../../../wav/WavReader";

export const CELL_DB = 0.5;
export const CELL_MIN_DB = -120;
export const CELL_COUNT = 260;

const PEAK_LEVEL_BIN_DB = 0.01;
const PEAK_LEVEL_BIN_COUNT = Math.round((CELL_COUNT * CELL_DB) / PEAK_LEVEL_BIN_DB);
const MOMENTARY_HALF_WINDOW_SECONDS = 0.2;
const LUFS_OFFSET = -0.691;
const SILENT_MEAN_SQUARE = 1e-20;
const SILENT_LOUDNESS_DB = -200;

export interface DetectionHistogram {
	readonly energy: Float64Array;
	readonly counts: Float64Array;
	readonly peakLevelCounts: Float64Array;
}

export interface SourceMeasurement {
	readonly integratedLufs: number;
	readonly lra: number | null;
	readonly truePeakDb: number | null;
	readonly pivotAutoDb: number;
	readonly floorAutoDb: number;
	readonly limitAutoDb: number;
	readonly detectionHistogram: DetectionHistogram;
	readonly loudnessEnvelope: SampleFile;
	readonly peakEnvelope: SampleFile;
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly weights: Float64Array;
	readonly frameCount: number;
	readonly bitDepth: SourceBitDepth;
}

const clampIndex = (index: number, count: number): number => Math.min(count - 1, Math.max(0, index));

export const cellOf = (levelDb: number): number =>
	clampIndex(Math.floor((levelDb - CELL_MIN_DB) / CELL_DB), CELL_COUNT);

export const cellCentreDb = (cell: number): number => CELL_MIN_DB + (cell + 0.5) * CELL_DB;

const peakLevelBinOf = (levelDb: number): number =>
	clampIndex(Math.floor((levelDb - CELL_MIN_DB) / PEAK_LEVEL_BIN_DB), PEAK_LEVEL_BIN_COUNT);

export const computeLimitAutoDb = (peakLevelCounts: Float64Array, limitPercentile: number): number => {
	let totalFrames = 0;

	for (let binIndex = 0; binIndex < peakLevelCounts.length; binIndex++) {
		totalFrames += peakLevelCounts[binIndex] ?? 0;
	}

	if (totalFrames === 0) {
		return Number.POSITIVE_INFINITY;
	}

	const loudestFrames = totalFrames * (1 - limitPercentile);
	let cumulative = 0;

	for (let binIndex = peakLevelCounts.length - 1; binIndex >= 0; binIndex--) {
		const count = peakLevelCounts[binIndex] ?? 0;

		if (count === 0) {
			continue;
		}

		cumulative += count;

		if (cumulative >= loudestFrames) {
			return CELL_MIN_DB + (binIndex + 0.5) * PEAK_LEVEL_BIN_DB;
		}
	}

	return Number.POSITIVE_INFINITY;
};

export const bodyPeakDbOf = (histogram: DetectionHistogram, pivotDb: number): number => {
	const { counts } = histogram;
	const peakCounts = new Float64Array(CELL_COUNT);
	let total = 0;

	for (let loudnessCell = cellOf(pivotDb); loudnessCell < CELL_COUNT; loudnessCell++) {
		const row = loudnessCell * CELL_COUNT;

		for (let peakCell = 0; peakCell < CELL_COUNT; peakCell++) {
			const count = counts[row + peakCell] ?? 0;

			peakCounts[peakCell] = (peakCounts[peakCell] ?? 0) + count;
			total += count;
		}
	}

	if (total === 0) {
		return Number.NEGATIVE_INFINITY;
	}

	let cumulative = 0;

	for (let peakCell = 0; peakCell < CELL_COUNT; peakCell++) {
		cumulative += peakCounts[peakCell] ?? 0;

		if (cumulative >= total / 2) {
			return cellCentreDb(peakCell);
		}
	}

	return cellCentreDb(CELL_COUNT - 1);
};

class FrameQueue {
	private buffer = new Float64Array(1024);
	private start = 0;
	private end = 0;

	get length(): number {
		return this.end - this.start;
	}

	push(values: Float64Array): void {
		const needed = this.length + values.length;

		if (this.end + values.length > this.buffer.length) {
			const target =
				needed > this.buffer.length ? new Float64Array(Math.max(needed, 2 * this.buffer.length)) : this.buffer;

			target.set(this.buffer.subarray(this.start, this.end), 0);
			this.buffer = target;
			this.end = this.length;
			this.start = 0;
		}

		this.buffer.set(values, this.end);
		this.end += values.length;
	}

	take(count: number): Float64Array {
		const taken = this.buffer.subarray(this.start, this.start + count);

		this.start += count;

		return taken;
	}
}

const collapseMaxPerFrame = (upsampled: Float64Array, frameCount: number, output: Float64Array): void => {
	for (let baseIndex = 0; baseIndex < frameCount; baseIndex++) {
		const offset = baseIndex * UPSAMPLE_FACTOR;
		let max = 0;

		for (let phase = 0; phase < UPSAMPLE_FACTOR; phase++) {
			const sample = upsampled[offset + phase] ?? 0;

			if (sample > max) {
				max = sample;
			}
		}

		output[baseIndex] = max;
	}
};

const maxOf = (values: Float64Array, length: number, start: number): number => {
	let max = start;

	for (let index = 0; index < length; index++) {
		const value = values[index] ?? 0;

		if (value > max) {
			max = value;
		}
	}

	return max;
};

const absoluteMaxOf = (channels: ReadonlyArray<Float64Array>, frames: number, start: number): number => {
	let max = start;

	for (const channel of channels) {
		for (let index = 0; index < frames; index++) {
			const sample = channel[index] ?? 0;
			const absolute = sample < 0 ? -sample : sample;

			if (absolute > max) {
				max = absolute;
			}
		}
	}

	return max;
};

const writeMaxAcrossChannels = (
	upChannels: ReadonlyArray<Float64Array>,
	target: Float64Array,
	length: number,
): void => {
	for (let upIndex = 0; upIndex < length; upIndex++) {
		let max = 0;

		for (let channelIndex = 0; channelIndex < upChannels.length; channelIndex++) {
			const upSample = upChannels[channelIndex]?.[upIndex] ?? 0;
			const absolute = upSample < 0 ? -upSample : upSample;

			if (absolute > max) {
				max = absolute;
			}
		}

		target[upIndex] = max;
	}
};

const loudnessDbOf = (meanSquare: number): number =>
	meanSquare < SILENT_MEAN_SQUARE ? SILENT_LOUDNESS_DB : LUFS_OFFSET + 10 * Math.log10(meanSquare);

export const measureSource = async (args: {
	source: BlockSource;
	scratch: Scratch;
	limitPercentile: number;
	halfWidthOf: (sampleRate: number) => number;
}): Promise<SourceMeasurement> => {
	const { source, scratch, limitPercentile, halfWidthOf } = args;
	const loudnessEnvelope = await SampleFile.create(scratch, "loudness");
	let peakEnvelope: SampleFile | undefined;

	try {
		const peakFile = await SampleFile.create(scratch, "peak");

		peakEnvelope = peakFile;

		const { sampleRate, channelCount, channelMask, bitDepth } = source.format;
		const weights = channelWeightsOf(channelCount, channelMask);
		const integrated = new IntegratedLufsAccumulator(sampleRate, weights);
		const shortTerm = new ShortTermLoudnessAccumulator(sampleRate, weights);
		const kWeighted = new KWeightedSquaredSum(sampleRate, weights);
		const loudnessWindow = new SlidingWindowMeanStream(Math.floor(MOMENTARY_HALF_WINDOW_SECONDS * sampleRate));
		const peakHold = new SlidingWindowMaxStream(halfWidthOf(sampleRate));
		const energy = new Float64Array(CELL_COUNT * CELL_COUNT);
		const counts = new Float64Array(CELL_COUNT * CELL_COUNT);
		const peakLevelCounts = new Float64Array(PEAK_LEVEL_BIN_COUNT);
		const loudnessQueue = new FrameQueue();
		const peakQueue = new FrameQueue();
		const energyQueue = new FrameQueue();
		const upsamplers: Array<TruePeakUpsampler> = [];
		const upsampleScratches: Array<Float64Array> = [];

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			upsamplers.push(new TruePeakUpsampler());
			upsampleScratches.push(new Float64Array(0));
		}

		let levelsScratch = new Float64Array(0);
		let baseScratch = new Float64Array(0);
		let energyScratch = new Float64Array(0);
		let frameIndex = 0;
		let skipRemaining = DELAY_FRAMES * UPSAMPLE_FACTOR;
		let detectedFrames = 0;
		let rawMax = 0;
		let interpolatedMax = 0;
		let preRingMax = 0;

		const accumulateAligned = (): void => {
			const frames = Math.min(loudnessQueue.length, peakQueue.length, energyQueue.length);

			if (frames === 0) {
				return;
			}

			const loudnessDb = loudnessQueue.take(frames);
			const peakDb = peakQueue.take(frames);
			const frameEnergy = energyQueue.take(frames);

			for (let index = 0; index < frames; index++) {
				const cell =
					cellOf(loudnessDb[index] ?? SILENT_LOUDNESS_DB) * CELL_COUNT +
					cellOf(peakDb[index] ?? SILENT_LOUDNESS_DB);

				energy[cell] = (energy[cell] ?? 0) + (frameEnergy[index] ?? 0);
				counts[cell] = (counts[cell] ?? 0) + 1;
			}
		};

		const persistLoudness = async (meanSquares: Float64Array): Promise<void> => {
			const loudnessDb = new Float64Array(meanSquares.length);

			for (let index = 0; index < meanSquares.length; index++) {
				loudnessDb[index] = loudnessDbOf(Math.max(0, meanSquares[index] ?? 0));
			}

			await loudnessEnvelope.append(loudnessDb, loudnessDb.length);
			loudnessQueue.push(loudnessDb);
			accumulateAligned();
		};

		const persistPeak = async (held: Float64Array): Promise<void> => {
			const peakDb = new Float64Array(held.length);

			for (let index = 0; index < held.length; index++) {
				peakDb[index] = linearToDb(held[index] ?? 0);
			}

			await peakFile.append(peakDb, peakDb.length);
			peakQueue.push(peakDb);
			accumulateAligned();
		};

		const pushAlignedDetection = async (upLength: number): Promise<void> => {
			interpolatedMax = maxOf(levelsScratch, upLength, interpolatedMax);

			const skipped = Math.min(skipRemaining, upLength);

			skipRemaining -= skipped;
			preRingMax = maxOf(levelsScratch, skipped, preRingMax);

			const frames = Math.min((upLength - skipped) / UPSAMPLE_FACTOR, frameIndex - detectedFrames);

			if (frames <= 0) {
				return;
			}

			if (baseScratch.length < frames) {
				baseScratch = new Float64Array(frames);
			}

			collapseMaxPerFrame(levelsScratch.subarray(skipped), frames, baseScratch);

			if (detectedFrames === 0) {
				baseScratch[0] = Math.max(baseScratch[0] ?? 0, preRingMax);
			}

			detectedFrames += frames;

			if (detectedFrames === frameIndex) {
				const tailStart = skipped + frames * UPSAMPLE_FACTOR;
				const tailMax = maxOf(levelsScratch.subarray(tailStart), upLength - tailStart, 0);

				baseScratch[frames - 1] = Math.max(baseScratch[frames - 1] ?? 0, tailMax);
			}

			const levels = baseScratch.subarray(0, frames);

			for (let index = 0; index < frames; index++) {
				const level = levels[index] ?? 0;

				if (level > 0) {
					const bin = peakLevelBinOf(20 * Math.log10(level));

					peakLevelCounts[bin] = (peakLevelCounts[bin] ?? 0) + 1;
				}
			}

			await persistPeak(peakHold.push(levels, false));
		};

		for await (const block of source.blocks()) {
			const frames = block.channels[0]?.length ?? 0;

			if (frames === 0) {
				break;
			}

			rawMax = absoluteMaxOf(block.channels, frames, rawMax);
			integrated.push(block.channels, frames);
			shortTerm.push(block.channels, frames);

			if (energyScratch.length < frames) {
				energyScratch = new Float64Array(frames);
			}

			const frameEnergy = energyScratch.subarray(0, frames);

			kWeighted.push(block.channels, frames, frameEnergy);
			energyQueue.push(frameEnergy);
			await persistLoudness(loudnessWindow.push(frameEnergy, false));

			const upChunkLength = frames * UPSAMPLE_FACTOR;

			if (levelsScratch.length < upChunkLength) {
				levelsScratch = new Float64Array(upChunkLength);
			}

			const upChannels: Array<Float64Array> = [];

			for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
				const channel = block.channels[channelIndex];
				const upsampler = upsamplers[channelIndex];

				if (channel === undefined || upsampler === undefined) {
					upChannels.push(new Float64Array(upChunkLength));

					continue;
				}

				let scratchBuffer = upsampleScratches[channelIndex] ?? new Float64Array(0);

				if (scratchBuffer.length < upChunkLength) {
					scratchBuffer = new Float64Array(upChunkLength);
					upsampleScratches[channelIndex] = scratchBuffer;
				}

				upsampler.upsample(channel, frames, scratchBuffer);
				upChannels.push(scratchBuffer.subarray(0, upChunkLength));
			}

			writeMaxAcrossChannels(upChannels, levelsScratch, upChunkLength);
			frameIndex += frames;

			await pushAlignedDetection(upChunkLength);
		}

		const flushLength = FLUSH_FRAMES * UPSAMPLE_FACTOR;
		const flushChannels = upsamplers.map((upsampler) => {
			const flushed = new Float64Array(flushLength);

			upsampler.flush(flushed);

			return flushed;
		});

		if (levelsScratch.length < flushLength) {
			levelsScratch = new Float64Array(flushLength);
		}

		writeMaxAcrossChannels(flushChannels, levelsScratch, flushLength);

		await pushAlignedDetection(flushLength);
		await persistPeak(peakHold.push(new Float64Array(0), true));
		await persistLoudness(loudnessWindow.push(new Float64Array(0), true));

		const shortTermSeries = shortTerm.finalize();
		const stats = getLraConsideredStats(shortTermSeries.subarray(0, shortTerm.sourceWindowCount));

		return {
			integratedLufs: integrated.finalize(),
			lra: computeLoudnessRange(shortTermSeries),
			truePeakDb: peakDbOrNull(Math.max(rawMax, interpolatedMax)),
			pivotAutoDb: stats.median,
			floorAutoDb: stats.minimum,
			limitAutoDb: computeLimitAutoDb(peakLevelCounts, limitPercentile),
			detectionHistogram: { energy, counts, peakLevelCounts },
			loudnessEnvelope,
			peakEnvelope: peakFile,
			sampleRate,
			channelCount,
			weights,
			frameCount: frameIndex,
			bitDepth,
		};
	} catch (error: unknown) {
		try {
			await peakEnvelope?.close();
		} finally {
			await loudnessEnvelope.close();
		}

		throw error;
	}
};
