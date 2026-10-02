import { AmplitudeHistogramAccumulator } from "../../../measurement/AmplitudeHistogramAccumulator";
import { IntegratedLufsAccumulator } from "../../../measurement/IntegratedLufsAccumulator";
import { computeLoudnessRange, getLraConsideredStats } from "../../../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../../../measurement/ShortTermLoudnessAccumulator";
import { SlidingWindowMaxStream } from "../../../measurement/SlidingWindowStreams";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { TruePeakUpsampler } from "../../../measurement/TruePeakUpsampler";
import { dbToLinear, linearToDb } from "../../../utils/db";
import { SampleFile } from "../../../utils/SampleFile";
import { BLOCK_FRAMES, type BlockSource } from "../../../wav/WavReader";
import type { Scratch } from "../../../utils/Scratch";
import type { SourceBitDepth } from "../../../wav/utils/wavFormat";

const OVERSAMPLE_FACTOR = 4;
const HISTOGRAM_BUCKETS = 1024;
const PIVOT_FALLBACK_DB = -40;
const DETECTION_DELAY_FRAMES = 6;
const FLUSH_FRAMES = 11;

export interface DetectionHistogram {
	readonly levelCounts: Float64Array;
	readonly levelBucketMax: number;
	readonly heldEnergy: Float64Array;
	readonly heldBucketMax: number;
	readonly totalSamples: number;
}

export interface SourceMeasurement {
	readonly integratedLufs: number;
	readonly lra: number;
	readonly truePeakDb: number;
	readonly pivotAutoDb: number;
	readonly floorAutoDb: number;
	readonly limitAutoDb: number;
	readonly detectionHistogram: DetectionHistogram;
	readonly detectionEnvelope: SampleFile;
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly frameCount: number;
	readonly bitDepth: SourceBitDepth;
}

const collapseMaxOf4 = (oversampled: Float64Array, frameCount: number, output: Float64Array): void => {
	for (let baseIndex = 0; baseIndex < frameCount; baseIndex++) {
		const offset = baseIndex * OVERSAMPLE_FACTOR;
		const s0 = oversampled[offset] ?? 0;
		const s1 = oversampled[offset + 1] ?? 0;
		const s2 = oversampled[offset + 2] ?? 0;
		const s3 = oversampled[offset + 3] ?? 0;
		const m01 = s0 > s1 ? s0 : s1;
		const m23 = s2 > s3 ? s2 : s3;

		output[baseIndex] = m01 > m23 ? m01 : m23;
	}
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

const writeFrameEnergies = (
	channels: ReadonlyArray<Float64Array>,
	frames: number,
	ring: Float64Array,
	firstFrameIndex: number,
): void => {
	for (let frameOffset = 0; frameOffset < frames; frameOffset++) {
		let energy = 0;

		for (const channel of channels) {
			const sample = channel[frameOffset] ?? 0;

			energy += sample * sample;
		}

		ring[(firstFrameIndex + frameOffset) % ring.length] = energy;
	}
};

const totalSamplesOf = (buckets: Float64Array): number => {
	let totalSamples = 0;

	for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
		totalSamples += buckets[bucketIndex] ?? 0;
	}

	return totalSamples;
};

export const computeLimitAutoDb = (
	levelCounts: Float64Array,
	levelBucketMax: number,
	pivotAutoDb: number,
	limitPercentile: number,
): number => {
	if (levelBucketMax === 0) {
		return Number.POSITIVE_INFINITY;
	}

	const totalSamples = totalSamplesOf(levelCounts);

	if (totalSamples === 0) {
		return Number.POSITIVE_INFINITY;
	}

	const bucketWidth = levelBucketMax / levelCounts.length;
	const effectivePivotDb = Number.isFinite(pivotAutoDb) ? pivotAutoDb : PIVOT_FALLBACK_DB;
	const pivotLinear = dbToLinear(effectivePivotDb);
	const rawStart = Math.floor(pivotLinear / bucketWidth);
	const startBucket = Math.min(levelCounts.length - 1, Math.max(0, rawStart));
	const targetCount = totalSamples * (1 - limitPercentile);
	let cumulative = 0;
	let limitBucket = -1;

	for (let bucketIndex = levelCounts.length - 1; bucketIndex >= startBucket; bucketIndex--) {
		cumulative += levelCounts[bucketIndex] ?? 0;

		if (cumulative >= targetCount) {
			limitBucket = bucketIndex;

			break;
		}
	}

	if (limitBucket === -1) {
		return Number.POSITIVE_INFINITY;
	}

	const linearLevel = (limitBucket + 0.5) * bucketWidth;

	return linearToDb(linearLevel);
};

const writeLinearAsDb = (linear: Float64Array, output: Float64Array): void => {
	for (let index = 0; index < linear.length; index++) {
		output[index] = linearToDb(linear[index] ?? 0);
	}
};

export const measureSource = async (args: {
	source: BlockSource;
	scratch: Scratch;
	limitPercentile: number;
	halfWidthOf: (sampleRate: number) => number;
}): Promise<SourceMeasurement> => {
	const { source, scratch, limitPercentile, halfWidthOf } = args;
	const detectionEnvelope = await SampleFile.create(scratch, "detection");

	try {
		const { sampleRate, channelCount, bitDepth } = source.format;
		const halfWidth = halfWidthOf(sampleRate);
		const truePeak = new TruePeakAccumulator(channelCount);
		const integrated = new IntegratedLufsAccumulator(sampleRate, channelCount);
		const shortTerm = new ShortTermLoudnessAccumulator(sampleRate, channelCount);
		const levelHistogram = new AmplitudeHistogramAccumulator(HISTOGRAM_BUCKETS);
		const heldHistogram = new AmplitudeHistogramAccumulator(HISTOGRAM_BUCKETS);
		const slidingWindow = new SlidingWindowMaxStream(halfWidth);
		const energyRing = new Float64Array(BLOCK_FRAMES + halfWidth + DETECTION_DELAY_FRAMES);
		const upsamplers: Array<TruePeakUpsampler> = [];
		const upsampleScratches: Array<Float64Array> = [];

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			upsamplers.push(new TruePeakUpsampler());
			upsampleScratches.push(new Float64Array(0));
		}

		let levelsScratch = new Float64Array(0);
		let baseScratch = new Float64Array(0);
		let dbScratch = new Float64Array(0);
		let energyScratch = new Float64Array(0);
		let frameIndex = 0;
		let emittedIndex = 0;
		let skipRemaining = DETECTION_DELAY_FRAMES * OVERSAMPLE_FACTOR;
		let detectedFrames = 0;

		const persistPooled = async (pooled: Float64Array): Promise<void> => {
			if (pooled.length === 0) {
				return;
			}

			if (energyScratch.length < pooled.length) {
				energyScratch = new Float64Array(pooled.length);
			}

			for (let pooledIndex = 0; pooledIndex < pooled.length; pooledIndex++) {
				energyScratch[pooledIndex] = energyRing[(emittedIndex + pooledIndex) % energyRing.length] ?? 0;
			}

			emittedIndex += pooled.length;
			heldHistogram.push(pooled, pooled.length, energyScratch);

			if (dbScratch.length < pooled.length) {
				dbScratch = new Float64Array(pooled.length);
			}

			writeLinearAsDb(pooled, dbScratch);
			await detectionEnvelope.append(dbScratch, pooled.length);
		};

		const pushDetection = async (levels: Float64Array, frames: number): Promise<void> => {
			levelHistogram.push(levels, frames);
			await persistPooled(slidingWindow.push(levels, false));
		};

		const pushAlignedDetection = async (upLength: number): Promise<void> => {
			const skipped = Math.min(skipRemaining, upLength);

			skipRemaining -= skipped;

			const frames = Math.min((upLength - skipped) / OVERSAMPLE_FACTOR, frameIndex - detectedFrames);

			if (frames <= 0) {
				return;
			}

			if (baseScratch.length < frames) {
				baseScratch = new Float64Array(frames);
			}

			collapseMaxOf4(levelsScratch.subarray(skipped), frames, baseScratch);
			detectedFrames += frames;

			await pushDetection(baseScratch.subarray(0, frames), frames);
		};

		for await (const block of source.blocks()) {
			const frames = block.channels[0]?.length ?? 0;

			if (frames === 0) {
				break;
			}

			truePeak.push(block.channels, frames);
			integrated.push(block.channels, frames);
			shortTerm.push(block.channels, frames);

			const upChunkLength = frames * OVERSAMPLE_FACTOR;

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
			writeFrameEnergies(block.channels, frames, energyRing, frameIndex);
			frameIndex += frames;

			await pushAlignedDetection(upChunkLength);
		}

		const flushLength = FLUSH_FRAMES * OVERSAMPLE_FACTOR;
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
		await persistPooled(slidingWindow.push(new Float64Array(0), true));

		const levelResult = levelHistogram.finalize();
		const heldResult = heldHistogram.finalize();
		const shortTermSeries = shortTerm.finalize();
		const stats = getLraConsideredStats(shortTermSeries.subarray(0, shortTerm.sourceWindowCount));

		return {
			integratedLufs: integrated.finalize(),
			lra: shortTermSeries.length === 0 ? 0 : computeLoudnessRange(shortTermSeries),
			truePeakDb: linearToDb(truePeak.finalize()),
			pivotAutoDb: stats.median,
			floorAutoDb: stats.minimum,
			limitAutoDb: computeLimitAutoDb(levelResult.buckets, levelResult.bucketMax, stats.median, limitPercentile),
			detectionHistogram: {
				levelCounts: levelResult.buckets,
				levelBucketMax: levelResult.bucketMax,
				heldEnergy: heldResult.buckets,
				heldBucketMax: heldResult.bucketMax,
				totalSamples: totalSamplesOf(levelResult.buckets),
			},
			detectionEnvelope,
			sampleRate,
			channelCount,
			frameCount: frameIndex,
			bitDepth,
		};
	} catch (error: unknown) {
		await detectionEnvelope.close();

		throw error;
	}
};
