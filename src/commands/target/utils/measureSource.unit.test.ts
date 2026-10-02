import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { channelWeightsOf } from "../../../measurement/channelWeights";
import { getLraConsideredStats } from "../../../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../../../measurement/ShortTermLoudnessAccumulator";
import { dbToLinear } from "../../../utils/db";
import { createLevelSegments, createNoise, createSine } from "../../../utils/testSignals";
import { Scratch } from "../../../utils/Scratch";
import { writeExtensibleWav } from "../../../utils/testWav";
import { BLOCK_FRAMES, WavReader, type AudioBlock, type BlockSource } from "../../../wav/WavReader";
import { WavWriter } from "../../../wav/WavWriter";
import type { SampleFile } from "../../../utils/SampleFile";
import { withWavReader } from "../../utils/withWavReader";
import { computeLimitAutoDb, measureSource, type DetectionHistogram, type SourceMeasurement } from "./measureSource";
import { windowSamplesFromMs } from "./window";

const SAMPLE_RATE = 48000;

const measureFile = async (args: {
	inputPath: string;
	scratch: Scratch;
	limitPercentile: number;
	halfWidth: number;
}): Promise<SourceMeasurement> =>
	withWavReader(args.inputPath, async (source) =>
		measureSource({
			source,
			scratch: args.scratch,
			limitPercentile: args.limitPercentile,
			halfWidthOf: () => args.halfWidth,
		}),
	);

const writeWav = async (path: string, channels: Array<Float64Array>): Promise<void> => {
	const writer = await WavWriter.create(
		{ kind: "file", path },
		{
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			channelMask: 0,
			bitDepth: "32f",
			frameCount: channels[0]?.length ?? 0,
		},
	);

	await writer.write(channels);
	await writer.close();
};

const readEnvelope = async (sampleFile: SampleFile): Promise<Float64Array> => {
	const envelope = new Float64Array(sampleFile.frameCount);
	let offset = 0;

	for await (const chunk of sampleFile.blocks()) {
		envelope.set(chunk, offset);
		offset += chunk.length;
	}

	return envelope;
};

describe("computeLimitAutoDb", () => {
	it("returns +Infinity for an empty histogram", () => {
		expect(computeLimitAutoDb(new Float64Array(16), 0, -20, 0.995)).toBe(Number.POSITIVE_INFINITY);
		expect(computeLimitAutoDb(new Float64Array(16), 1, -20, 0.995)).toBe(Number.POSITIVE_INFINITY);
	});

	it("returns +Infinity when the post-pivot window is sparse", () => {
		const buckets = new Float64Array(16);

		buckets[0] = 10_000;
		buckets[15] = 1;

		expect(computeLimitAutoDb(buckets, 1, 20 * Math.log10(0.9), 0.995)).toBe(Number.POSITIVE_INFINITY);
	});

	it("lands in the upper portion of a populated post-pivot window", () => {
		const buckets = new Float64Array(16);

		buckets.fill(100);
		buckets[14] = 200;
		buckets[15] = 50;

		const limitDb = computeLimitAutoDb(buckets, 1, -40, 0.995);

		expect(Number.isFinite(limitDb)).toBe(true);
		expect(limitDb).toBeGreaterThan(-10);
	});
});

describe("measureSource", () => {
	let workingDirectory: string;
	let scratch: Scratch | undefined;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-measure-source-"));
	});

	afterEach(async () => {
		if (scratch !== undefined) {
			await scratch.dispose();
			scratch = undefined;
		}

		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("emits a detection envelope whose length matches the source through the final drain", async () => {
		scratch = await Scratch.create();

		const frameCount = 70_000;
		const inputPath = join(workingDirectory, "long.wav");

		await writeWav(inputPath, createSine(frameCount, 1, SAMPLE_RATE, 220, 0.2));

		const measurement = await measureFile({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});

		expect(measurement.detectionEnvelope.frameCount).toBe(frameCount);
		expect(measurement.frameCount).toBe(frameCount);
		expect(Number.isFinite(measurement.integratedLufs)).toBe(true);
		expect(Number.isFinite(measurement.truePeakDb)).toBe(true);

		await measurement.detectionEnvelope.close();
	});

	it("returns +Infinity limitAutoDb for a silent source", async () => {
		scratch = await Scratch.create();

		const inputPath = join(workingDirectory, "silence.wav");

		await writeWav(inputPath, [new Float64Array(SAMPLE_RATE)]);

		const measurement = await measureFile({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});

		expect(measurement.limitAutoDb).toBe(Number.POSITIVE_INFINITY);
		expect(measurement.detectionEnvelope.frameCount).toBe(SAMPLE_RATE);

		await measurement.detectionEnvelope.close();
	});

	it("returns the floored truePeakDb for a 1e-12-peak source", async () => {
		scratch = await Scratch.create();

		const inputPath = join(workingDirectory, "tiny.wav");

		await writeWav(inputPath, [new Float64Array(SAMPLE_RATE).fill(1e-12)]);

		const measurement = await measureFile({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});

		expect(measurement.truePeakDb).toBeCloseTo(-200, 6);

		await measurement.detectionEnvelope.close();
	});

	it("derives considered-set anchors from a level-step programme", async () => {
		scratch = await Scratch.create();

		const frameCount = SAMPLE_RATE * 4;
		const channel = new Float64Array(frameCount);
		const low = dbToLinear(-30);
		const high = dbToLinear(-20);

		for (let index = 0; index < frameCount; index++) {
			const amplitude = index < SAMPLE_RATE * 2 ? high : low;

			channel[index] = amplitude * Math.sin((2 * Math.PI * 1000 * index) / SAMPLE_RATE);
		}

		const inputPath = join(workingDirectory, "step.wav");

		await writeWav(inputPath, [channel]);

		const measurement = await measureFile({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});

		expect(Number.isFinite(measurement.pivotAutoDb)).toBe(true);
		expect(Number.isFinite(measurement.floorAutoDb)).toBe(true);
		expect(measurement.floorAutoDb).toBeLessThan(measurement.pivotAutoDb);
		expect(measurement.lra).toBeGreaterThan(0);

		await measurement.detectionEnvelope.close();
	});

	it("returns empty source-only stats for a source shorter than one short-term window", async () => {
		scratch = await Scratch.create();

		const frameCount = SAMPLE_RATE * 2;
		const channels = createSine(frameCount, 1, SAMPLE_RATE, 1000, 0.1);
		const inputPath = join(workingDirectory, "short.wav");

		await writeWav(inputPath, channels);

		const measurement = await measureFile({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});
		const accumulator = new ShortTermLoudnessAccumulator(SAMPLE_RATE, channelWeightsOf(1, 0));

		accumulator.push(channels, frameCount);

		const shortTermSeries = accumulator.finalize();
		const sourceOnly = getLraConsideredStats(shortTermSeries.subarray(0, accumulator.sourceWindowCount));
		const tailIncluded = getLraConsideredStats(shortTermSeries);

		expect(accumulator.sourceWindowCount).toBe(0);
		expect(sourceOnly.minimum).toBe(Number.POSITIVE_INFINITY);
		expect(measurement.floorAutoDb).toBe(Number.POSITIVE_INFINITY);
		expect(measurement.pivotAutoDb).toBe(Number.POSITIVE_INFINITY);
		expect(Number.isFinite(measurement.integratedLufs)).toBe(true);
		expect(Number.isFinite(tailIncluded.minimum)).toBe(true);

		await measurement.detectionEnvelope.close();
	});

	it("derives floorAutoDb from source-only windows when the source ends on a quiet segment", async () => {
		scratch = await Scratch.create();

		const channels = createLevelSegments(
			[
				{ seconds: 5, frequency: 1000, db: -20 },
				{ seconds: 3, frequency: 1000, db: -35 },
			],
			SAMPLE_RATE,
			1,
		);
		const inputPath = join(workingDirectory, "quiet-ending.wav");

		await writeWav(inputPath, channels);

		const measurement = await measureFile({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});
		const accumulator = new ShortTermLoudnessAccumulator(SAMPLE_RATE, channelWeightsOf(1, 0));

		accumulator.push(channels, channels[0]?.length ?? 0);

		const shortTermSeries = accumulator.finalize();
		const sourceOnly = getLraConsideredStats(shortTermSeries.subarray(0, accumulator.sourceWindowCount));
		const tailIncluded = getLraConsideredStats(shortTermSeries);

		expect(measurement.floorAutoDb).toBeCloseTo(sourceOnly.minimum, 5);
		expect(sourceOnly.minimum).not.toBe(tailIncluded.minimum);
		expect(Math.abs(measurement.floorAutoDb - tailIncluded.minimum)).toBeGreaterThan(0.01);

		await measurement.detectionEnvelope.close();
	});

	it("derives the limit from the per-frame detection, unmoved by smoothing", async () => {
		scratch = await Scratch.create();

		const bedDb = -30;
		const burstDb = -6;
		const burstFrames = windowSamplesFromMs(1, SAMPLE_RATE);
		const burstCount = 8;
		const [channel = new Float64Array(0)] = createSine(SAMPLE_RATE * 6, 1, SAMPLE_RATE, 1000, dbToLinear(bedDb));

		for (let burstIndex = 0; burstIndex < burstCount; burstIndex++) {
			const burstStart = SAMPLE_RATE + (burstIndex * SAMPLE_RATE) / 2;

			for (let offset = 0; offset < burstFrames; offset++) {
				channel[burstStart + offset] = dbToLinear(burstDb) * Math.sin((2 * Math.PI * 1000 * offset) / SAMPLE_RATE);
			}
		}

		const inputPath = join(workingDirectory, "bursts.wav");

		await writeWav(inputPath, [channel]);

		const narrow = await measureFile({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});

		await narrow.detectionEnvelope.close();

		const wide = await measureFile({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(40, SAMPLE_RATE),
		});

		await wide.detectionEnvelope.close();

		expect(burstCount * burstFrames).toBeLessThan(channel.length * 0.005);
		expect(burstCount * windowSamplesFromMs(40, SAMPLE_RATE)).toBeGreaterThan(channel.length * 0.005);
		expect(Number.isFinite(narrow.limitAutoDb)).toBe(true);
		expect(wide.limitAutoDb).toBe(narrow.limitAutoDb);
		expect(narrow.limitAutoDb).toBeLessThan((bedDb + burstDb) / 2);
	});

	it("keys held energy on the held level", async () => {
		scratch = await Scratch.create();

		const frameCount = SAMPLE_RATE;
		const burstStart = SAMPLE_RATE / 2;
		const burstFrames = windowSamplesFromMs(10, SAMPLE_RATE);
		const bed = dbToLinear(-60);
		const burst = dbToLinear(-6);
		const channel = new Float64Array(frameCount);
		let burstEnergy = 0;

		for (let index = 0; index < frameCount; index++) {
			const isBurst = index >= burstStart && index < burstStart + burstFrames;
			const sample = (isBurst ? burst : bed) * Math.sin((2 * Math.PI * 1000 * index) / SAMPLE_RATE);

			channel[index] = sample;

			if (isBurst) {
				burstEnergy += sample * sample;
			}
		}

		const inputPath = join(workingDirectory, "burst.wav");

		await writeWav(inputPath, [channel]);

		const measurement = await measureFile({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});

		await measurement.detectionEnvelope.close();

		const { levelCounts, levelBucketMax, heldEnergy, heldBucketMax } = measurement.detectionHistogram;
		const threshold = dbToLinear(-30);
		const massAbove = (buckets: Float64Array, bucketMax: number): number => {
			const bucketWidth = bucketMax / buckets.length;
			let mass = 0;

			for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
				if ((bucketIndex + 0.5) * bucketWidth > threshold) {
					mass += buckets[bucketIndex] ?? 0;
				}
			}

			return mass;
		};

		expect(Math.abs(massAbove(heldEnergy, heldBucketMax) / burstEnergy - 1)).toBeLessThan(0.01);
		expect(Math.abs(massAbove(levelCounts, levelBucketMax) - burstFrames)).toBeLessThanOrEqual(12);
	});

	it("weights each channel's held energy by its stated position", async () => {
		scratch = await Scratch.create();

		const frameCount = SAMPLE_RATE;
		const [sine = new Float64Array(0)] = createSine(frameCount, 1, SAMPLE_RATE, 997, 0.5);
		const channels = Array.from({ length: 6 }, (_channel, index) =>
			index === 3 || index === 4 ? sine : new Float64Array(frameCount),
		);
		const inputPath = join(workingDirectory, "surround.wav");

		await writeExtensibleWav(inputPath, {
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			bitDepth: "32f",
			channelMask: 0x3f,
			channels,
		});

		const measurement = await measureFile({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});

		await measurement.detectionEnvelope.close();

		const sineEnergy = sine.reduce((sum, sample) => sum + Math.fround(sample) * Math.fround(sample), 0);
		const heldTotal = measurement.detectionHistogram.heldEnergy.reduce((sum, energy) => sum + energy, 0);

		expect(Array.from(measurement.weights)).toEqual([1, 1, 1, 0, 1.41, 1.41]);
		expect(Math.abs(heldTotal / (1.41 * sineEnergy) - 1)).toBeLessThan(1e-9);
	});

	const measureImpulseEnvelope = async (
		frameCount: number,
		impulseFrame: number,
		impulseLevel = 1,
	): Promise<Float64Array> => {
		scratch = await Scratch.create();

		const channel = new Float64Array(frameCount);

		channel[impulseFrame] = impulseLevel;

		const inputPath = join(workingDirectory, "impulse.wav");

		await writeWav(inputPath, [channel]);

		const measurement = await measureFile({ inputPath, scratch, limitPercentile: 0.995, halfWidth: 0 });
		const envelope = await readEnvelope(measurement.detectionEnvelope);

		await measurement.detectionEnvelope.close();

		return envelope;
	};

	it("keys held energy on the frame its held level measures across block boundaries", async () => {
		scratch = await Scratch.create();

		const frameCount = 2 * BLOCK_FRAMES + 8_000;
		const channels = createNoise(frameCount, 2, 7).map((channel) =>
			channel.map((sample, frameIndex) => sample * (0.3 + 0.25 * Math.sin((2 * Math.PI * frameIndex) / 3_001))),
		);
		const [left = new Float64Array(0)] = channels;

		left[100] = 0.95;

		const inputPath = join(workingDirectory, "multi-block.wav");

		await writeWav(inputPath, channels);

		const energies = new Float64Array(frameCount);

		for (const channel of channels) {
			for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
				const sample = Math.fround(channel[frameIndex] ?? 0);

				energies[frameIndex] = (energies[frameIndex] ?? 0) + sample * sample;
			}
		}

		for (const halfWidth of [0, 3, 48]) {
			const measurement = await measureFile({ inputPath, scratch, limitPercentile: 0.995, halfWidth });
			const levelsDb = await readEnvelope(measurement.detectionEnvelope);

			await measurement.detectionEnvelope.close();

			const { heldEnergy, heldBucketMax } = measurement.detectionHistogram;
			const expected = new Float64Array(heldEnergy.length);
			const scale = heldEnergy.length / heldBucketMax;
			let totalEnergy = 0;

			for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
				const bucketIndex = Math.min(
					heldEnergy.length - 1,
					Math.floor(dbToLinear(levelsDb[frameIndex] ?? 0) * scale),
				);

				expected[bucketIndex] = (expected[bucketIndex] ?? 0) + (energies[frameIndex] ?? 0);
				totalEnergy += energies[frameIndex] ?? 0;
			}

			expect(levelsDb).toHaveLength(frameCount);

			for (let bucketIndex = 0; bucketIndex < heldEnergy.length; bucketIndex++) {
				expect(Math.abs((heldEnergy[bucketIndex] ?? 0) - (expected[bucketIndex] ?? 0))).toBeLessThan(
					totalEnergy * 1e-12,
				);
			}
		}
	}, 30_000);

	it("reads an impulse's peak at its own frame", async () => {
		const envelope = await measureImpulseEnvelope(SAMPLE_RATE, 1000);

		expect(Math.abs(envelope[999] ?? Number.NaN)).toBeLessThan(0.3);
		expect(Math.abs(envelope[1000] ?? Number.NaN)).toBeLessThan(0.3);
		expect(envelope[998]).toBeLessThan(-10);
		expect(envelope[1001]).toBeLessThan(-10);
		expect(envelope[990]).toBeLessThan(-20);
		expect(envelope[1010]).toBeLessThan(-20);
	});

	it("reads an impulse in the final frame", async () => {
		const envelope = await measureImpulseEnvelope(SAMPLE_RATE, SAMPLE_RATE - 1);

		expect(envelope[SAMPLE_RATE - 1]).toBeGreaterThan(-1);
	});

	it("reads a one-frame source through the flush", async () => {
		const impulseLevel = 0.9;
		const envelope = await measureImpulseEnvelope(1, 0, impulseLevel);

		expect(envelope).toHaveLength(1);
		expect(Math.abs((envelope[0] ?? Number.NaN) - 20 * Math.log10(impulseLevel))).toBeLessThan(1);
	});

	it("emits an empty detection envelope for a zero-frame source", async () => {
		const envelope = await measureImpulseEnvelope(0, 0);

		expect(envelope).toHaveLength(0);
	});

	it("measures the same whatever the block size the source is read in", async () => {
		const measureScratch = await Scratch.create();

		scratch = measureScratch;

		const measureInChunks = async (
			inputPath: string,
			chunkFrames: number | undefined,
		): Promise<{ envelope: Float64Array; histogram: DetectionHistogram; frameCount: number }> => {
			const reader = await WavReader.open(inputPath);
			const source: BlockSource = {
				format: reader.format,
				blocks: async function* (): AsyncIterableIterator<AudioBlock> {
					for await (const block of reader.blocks()) {
						const frameCount = block.channels[0]?.length ?? 0;
						const step = chunkFrames ?? frameCount;

						for (let offset = 0; offset < frameCount; offset += step) {
							const take = Math.min(step, frameCount - offset);

							yield {
								channels: block.channels.map((channel) => channel.slice(offset, offset + take)),
								frameIndex: block.frameIndex + offset,
							};
						}
					}
				},
				close: async () => reader.close(),
			};

			try {
				const measurement = await measureSource({
					source,
					scratch: measureScratch,
					limitPercentile: 0.995,
					halfWidthOf: (sampleRate) => windowSamplesFromMs(1, sampleRate),
				});
				const envelope = await readEnvelope(measurement.detectionEnvelope);

				await measurement.detectionEnvelope.close();

				return { envelope, histogram: measurement.detectionHistogram, frameCount: measurement.frameCount };
			} finally {
				await source.close();
			}
		};

		const cases: ReadonlyArray<{ frameCount: number; chunkSizes: ReadonlyArray<number> }> = [
			{ frameCount: 1, chunkSizes: [1] },
			{ frameCount: 5, chunkSizes: [1, 2, 3] },
			{ frameCount: 6, chunkSizes: [1, 4, 5] },
			{ frameCount: 7, chunkSizes: [1, 3, 6] },
			{ frameCount: 2 * BLOCK_FRAMES + 8_000, chunkSizes: [4_093, 30_011, BLOCK_FRAMES - 1] },
		];

		for (const { frameCount, chunkSizes } of cases) {
			const inputPath = join(workingDirectory, `chunks-${frameCount}.wav`);
			const channels = createNoise(frameCount, 2, frameCount).map((channel) =>
				channel.map((sample) => sample * 0.5),
			);
			const [left = new Float64Array(0)] = channels;

			left[Math.min(100, frameCount - 1)] = 0.99;

			await writeWav(inputPath, channels);

			const whole = await measureInChunks(inputPath, undefined);

			expect(whole.frameCount).toBe(frameCount);
			expect(whole.envelope).toHaveLength(frameCount);

			for (const chunkFrames of chunkSizes) {
				expect(await measureInChunks(inputPath, chunkFrames)).toEqual(whole);
			}
		}
	}, 60_000);
});
