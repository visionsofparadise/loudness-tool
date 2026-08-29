import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbToLinear } from "../../../utils/db";
import { createSine } from "../../../utils/testSignals";
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
});
