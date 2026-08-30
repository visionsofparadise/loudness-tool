import { AmplitudeHistogramAccumulator } from "../../../measurement/AmplitudeHistogramAccumulator";
import { IntegratedLufsAccumulator } from "../../../measurement/IntegratedLufsAccumulator";
import { computeLoudnessRange, getLraConsideredStats } from "../../../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../../../measurement/ShortTermLoudnessAccumulator";
import { SlidingWindowMaxStream } from "../../../measurement/SlidingWindowStreams";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { TruePeakUpsampler } from "../../../measurement/TruePeakUpsampler";
import { dbToLinear, linearToDb } from "../../../utils/db";
import { SampleFile } from "../../../utils/SampleFile";
import { WavReader } from "../../../wav/WavReader";
import type { Scratch } from "../../../utils/Scratch";
import type { SourceBitDepth } from "../../../wav/utils/wavFormat";

const OVERSAMPLE_FACTOR = 4;
const HISTOGRAM_BUCKETS = 1024;
const PIVOT_FALLBACK_DB = -40;

export interface DetectionHistogram {
	readonly buckets: Uint32Array;
	readonly bucketMax: number;
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

const totalSamplesOf = (buckets: Uint32Array): number => {
	let totalSamples = 0;

	for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
		totalSamples += buckets[bucketIndex] ?? 0;
	}

	return totalSamples;
};

export const computeLimitAutoDb = (
	buckets: Uint32Array,
	bucketMax: number,
	pivotAutoDb: number,
	limitPercentile: number,
): number => {
	if (bucketMax === 0) {
		return Number.POSITIVE_INFINITY;
	}

	const totalSamples = totalSamplesOf(buckets);

	if (totalSamples === 0) {
		return Number.POSITIVE_INFINITY;
	}

	const bucketWidth = bucketMax / buckets.length;
	const effectivePivotDb = Number.isFinite(pivotAutoDb) ? pivotAutoDb : PIVOT_FALLBACK_DB;
	const pivotLinear = dbToLinear(effectivePivotDb);
	const rawStart = Math.floor(pivotLinear / bucketWidth);
	const startBucket = Math.min(buckets.length - 1, Math.max(0, rawStart));
	const targetCount = totalSamples * (1 - limitPercentile);
	let cumulative = 0;
	let limitBucket = -1;

	for (let bucketIndex = buckets.length - 1; bucketIndex >= startBucket; bucketIndex--) {
		cumulative += buckets[bucketIndex] ?? 0;

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
	inputPath: string;
	scratch: Scratch;
	limitPercentile: number;
	halfWidth: number;
}): Promise<SourceMeasurement> => {
	const { inputPath, scratch, limitPercentile, halfWidth } = args;
	const reader = await WavReader.open(inputPath);
	const detectionEnvelope = await SampleFile.create(scratch, "detection");

	try {
		const { sampleRate, channelCount, bitDepth, frameCount } = reader.format;
		const truePeak = new TruePeakAccumulator(channelCount);
		const integrated = new IntegratedLufsAccumulator(sampleRate, channelCount);
		const shortTerm = new ShortTermLoudnessAccumulator(sampleRate, channelCount);
		const histogram = new AmplitudeHistogramAccumulator(HISTOGRAM_BUCKETS);
		const slidingWindow = new SlidingWindowMaxStream(halfWidth);
		const upsamplers: Array<TruePeakUpsampler> = [];
		const upsampleScratches: Array<Float64Array> = [];

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			upsamplers.push(new TruePeakUpsampler());
			upsampleScratches.push(new Float64Array(0));
		}

		let levelsScratch = new Float64Array(0);
		let baseScratch = new Float64Array(0);
		let dbScratch = new Float64Array(0);

		const persistPooled = async (pooled: Float64Array): Promise<void> => {
			if (pooled.length === 0) {
				return;
			}

			histogram.push(pooled, pooled.length);

			if (dbScratch.length < pooled.length) {
				dbScratch = new Float64Array(pooled.length);
			}

			writeLinearAsDb(pooled, dbScratch);
			await detectionEnvelope.append(dbScratch, pooled.length);
		};

		for await (const block of reader.blocks()) {
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

			if (baseScratch.length < frames) {
				baseScratch = new Float64Array(frames);
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
			collapseMaxOf4(levelsScratch, frames, baseScratch);

			await persistPooled(slidingWindow.push(baseScratch.subarray(0, frames), false));
		}

		await persistPooled(slidingWindow.push(new Float64Array(0), true));

		const histogramResult = histogram.finalize();
		const shortTermSeries = shortTerm.finalize();
		const stats = getLraConsideredStats(shortTermSeries.subarray(0, shortTerm.sourceWindowCount));
		const totalSamples = totalSamplesOf(histogramResult.buckets);

		return {
			integratedLufs: integrated.finalize(),
			lra: shortTermSeries.length === 0 ? 0 : computeLoudnessRange(shortTermSeries),
			truePeakDb: 20 * Math.log10(truePeak.finalize()),
			pivotAutoDb: stats.median,
			floorAutoDb: stats.minimum,
			limitAutoDb: computeLimitAutoDb(
				histogramResult.buckets,
				histogramResult.bucketMax,
				stats.median,
				limitPercentile,
			),
			detectionHistogram: {
				buckets: histogramResult.buckets,
				bucketMax: histogramResult.bucketMax,
				totalSamples,
			},
			detectionEnvelope,
			sampleRate,
			channelCount,
			frameCount,
			bitDepth,
		};
	} catch (error: unknown) {
		await detectionEnvelope.close();

		throw error;
	} finally {
		await reader.close();
	}
};
