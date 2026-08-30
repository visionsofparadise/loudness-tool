import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLraConsideredStats } from "../../../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../../../measurement/ShortTermLoudnessAccumulator";
import { dbToLinear } from "../../../utils/db";
import { createLevelSegments, createSine } from "../../../utils/testSignals";
import { Scratch } from "../../../utils/Scratch";
import { WavWriter } from "../../../wav/WavWriter";
import { computeLimitAutoDb, measureSource } from "./measureSource";
import { windowSamplesFromMs } from "./window";

const SAMPLE_RATE = 48000;

const writeWav = async (path: string, channels: Array<Float64Array>): Promise<void> => {
	const writer = await WavWriter.create(path, {
		sampleRate: SAMPLE_RATE,
		channelCount: channels.length,
		bitDepth: "32f",
	});

	await writer.write(channels);
	await writer.close();
};

describe("computeLimitAutoDb", () => {
	it("returns +Infinity for an empty histogram", () => {
		expect(computeLimitAutoDb(new Uint32Array(16), 0, -20, 0.995)).toBe(Number.POSITIVE_INFINITY);
		expect(computeLimitAutoDb(new Uint32Array(16), 1, -20, 0.995)).toBe(Number.POSITIVE_INFINITY);
	});

	it("returns +Infinity when the post-pivot window is sparse", () => {
		const buckets = new Uint32Array(16);

		buckets[0] = 10_000;
		buckets[15] = 1;

		expect(computeLimitAutoDb(buckets, 1, 20 * Math.log10(0.9), 0.995)).toBe(Number.POSITIVE_INFINITY);
	});

	it("lands in the upper portion of a populated post-pivot window", () => {
		const buckets = new Uint32Array(16);

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

		const measurement = await measureSource({
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

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});

		expect(measurement.limitAutoDb).toBe(Number.POSITIVE_INFINITY);
		expect(measurement.detectionEnvelope.frameCount).toBe(SAMPLE_RATE);

		await measurement.detectionEnvelope.close();
	});

	it("returns an unfloored truePeakDb for a 1e-12-peak source", async () => {
		scratch = await Scratch.create();

		const inputPath = join(workingDirectory, "tiny.wav");

		await writeWav(inputPath, [new Float64Array(SAMPLE_RATE).fill(1e-12)]);

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});

		expect(measurement.truePeakDb).toBeLessThan(-220);
		expect(measurement.truePeakDb).toBeGreaterThan(-260);

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

		const measurement = await measureSource({
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

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});
		const accumulator = new ShortTermLoudnessAccumulator(SAMPLE_RATE, 1);

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

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});
		const accumulator = new ShortTermLoudnessAccumulator(SAMPLE_RATE, 1);

		accumulator.push(channels, channels[0]?.length ?? 0);

		const shortTermSeries = accumulator.finalize();
		const sourceOnly = getLraConsideredStats(shortTermSeries.subarray(0, accumulator.sourceWindowCount));
		const tailIncluded = getLraConsideredStats(shortTermSeries);

		expect(measurement.floorAutoDb).toBeCloseTo(sourceOnly.minimum, 5);
		expect(sourceOnly.minimum).not.toBe(tailIncluded.minimum);
		expect(Math.abs(measurement.floorAutoDb - tailIncluded.minimum)).toBeGreaterThan(0.01);

		await measurement.detectionEnvelope.close();
	});
});
