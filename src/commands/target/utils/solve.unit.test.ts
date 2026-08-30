import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbToLinear, linearToDb } from "../../../utils/db";
import { SampleFile } from "../../../utils/SampleFile";
import { createSine } from "../../../utils/testSignals";
import { Scratch } from "../../../utils/Scratch";
import { WavWriter } from "../../../wav/WavWriter";
import { type Anchors, gainDbAt } from "./curve";
import * as envelope from "./envelope";
import { measureSource, type DetectionHistogram } from "./measureSource";
import {
	assignPeakGainDb,
	attemptBeatsWinner,
	bisectBForTargetLufs,
	BOOST_LOWER_BOUND,
	BOOST_UPPER_BOUND,
	holdsTruePeak,
	isLegalAttempt,
	iterateForTargets,
	predictOutputLufs,
} from "./solve";
import { windowSamplesFromMs } from "./window";

const SAMPLE_RATE = 48000;

const baseAnchors = (overrides: Partial<Anchors> = {}): Anchors => ({
	floorDb: null,
	pivotDb: -30,
	limitDb: -3,
	B: 0,
	peakGainDb: 0,
	...overrides,
});

const singleLevelHistogram = (
	targetLevelDb: number,
	totalSamples: number,
	bucketCount = 1024,
	bucketMaxDb = 0,
): DetectionHistogram => {
	const bucketMax = dbToLinear(bucketMaxDb);
	const buckets = new Uint32Array(bucketCount);
	const targetLinear = dbToLinear(targetLevelDb);
	const bucketWidth = bucketMax / bucketCount;
	const bucketIndex = Math.min(bucketCount - 1, Math.max(0, Math.floor(targetLinear / bucketWidth)));

	buckets[bucketIndex] = totalSamples;

	return { buckets, bucketMax, totalSamples };
};

const uniformDbRangeHistogram = (
	lowLevelDb: number,
	highLevelDb: number,
	totalSamples: number,
	bucketCount = 1024,
	bucketMaxDb = 0,
): DetectionHistogram => {
	const bucketMax = dbToLinear(bucketMaxDb);
	const buckets = new Uint32Array(bucketCount);
	const bucketWidth = bucketMax / bucketCount;
	const lowLinear = dbToLinear(lowLevelDb);
	const highLinear = dbToLinear(highLevelDb);
	const lowBucket = Math.min(bucketCount - 1, Math.max(0, Math.floor(lowLinear / bucketWidth)));
	const highBucket = Math.min(bucketCount - 1, Math.max(0, Math.floor(highLinear / bucketWidth)));
	const span = Math.max(1, highBucket - lowBucket + 1);
	const perBucket = Math.floor(totalSamples / span);
	let placed = 0;

	for (let bucketIndex = lowBucket; bucketIndex <= highBucket; bucketIndex++) {
		buckets[bucketIndex] = perBucket;
		placed += perBucket;
	}

	buckets[lowBucket] = (buckets[lowBucket] ?? 0) + (totalSamples - placed);

	return { buckets, bucketMax, totalSamples };
};

const referenceLufsShift = (anchors: Anchors, histogram: DetectionHistogram): number => {
	const { buckets, bucketMax } = histogram;
	const bucketCount = buckets.length;
	const bucketWidth = bucketMax / bucketCount;
	let weightedGainEnergy = 0;
	let weightedSourceEnergy = 0;

	for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
		const count = buckets[bucketIndex] ?? 0;

		if (count === 0) {
			continue;
		}

		const centreLinear = (bucketIndex + 0.5) * bucketWidth;

		if (centreLinear <= 0) {
			continue;
		}

		const energy = count * centreLinear * centreLinear;
		const centreDb = linearToDb(centreLinear);
		const gainDb = gainDbAt(centreDb, anchors);
		const gainLinear = Math.pow(10, gainDb / 20);

		weightedSourceEnergy += energy;
		weightedGainEnergy += energy * gainLinear * gainLinear;
	}

	return 10 * Math.log10(weightedGainEnergy / weightedSourceEnergy);
};

const writeWav = async (path: string, channels: Array<Float64Array>): Promise<void> => {
	const writer = await WavWriter.create(path, {
		sampleRate: SAMPLE_RATE,
		channelCount: channels.length,
		bitDepth: "32f",
	});

	await writer.write(channels);
	await writer.close();
};

const makeCrossAxis = (seconds: number): Float64Array => {
	const frameCount = SAMPLE_RATE * seconds;
	const channel = new Float64Array(frameCount);
	const bed = dbToLinear(-30);
	const impulse = dbToLinear(-3);
	const period = Math.round(SAMPLE_RATE / 8);
	const impulseStart = SAMPLE_RATE;
	const impulseEnd = SAMPLE_RATE * 2;

	for (let index = 0; index < frameCount; index++) {
		const sine = bed * Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE);

		channel[index] = index >= impulseStart && index < impulseEnd && index % period === 0 ? impulse : sine;
	}

	return channel;
};

describe("predictOutputLufs", () => {
	it("returns -Infinity for an empty histogram", () => {
		expect(
			predictOutputLufs(-20, baseAnchors(), { buckets: new Uint32Array(0), bucketMax: 0, totalSamples: 0 }),
		).toBe(-Infinity);
	});

	it("matches sourceLufs + 10·log10(mean(g²)) on a known histogram", () => {
		const histogram = uniformDbRangeHistogram(-30, -6, 100_000);
		const anchors = baseAnchors({ pivotDb: -28, limitDb: -6, B: 3, peakGainDb: 5 });
		const sourceLufs = -23;

		expect(predictOutputLufs(sourceLufs, anchors, histogram)).toBeCloseTo(
			sourceLufs + referenceLufsShift(anchors, histogram),
			6,
		);
	});

	it("shifts a single-level flat curve by B", () => {
		const histogram = singleLevelHistogram(-20, 50_000);
		const anchors = baseAnchors({ pivotDb: -30, limitDb: -3, B: 6, peakGainDb: 6 });

		expect(predictOutputLufs(-23, anchors, histogram)).toBeCloseTo(-17, 4);
	});
});

describe("bisectBForTargetLufs", () => {
	it("returns a B whose calibrated predictor lands near the target", () => {
		const histogram = uniformDbRangeHistogram(-30, -6, 100_000);
		const sourceLufs = -23;
		const targetLufs = -19;
		const anchorsBase = { floorDb: null, pivotDb: -28, limitDb: -6 };
		const tpCap = -1 - -6;
		const landingB = bisectBForTargetLufs({
			sourceLufs,
			targetLufs,
			anchors: anchorsBase,
			histogram,
			tpCap,
			neverExpand: false,
			residual: 0,
			tolerance: 0.1,
		});
		const landed: Anchors = {
			...anchorsBase,
			B: landingB,
			peakGainDb: assignPeakGainDb(landingB, tpCap, false),
		};

		expect(landingB).toBeGreaterThanOrEqual(BOOST_LOWER_BOUND);
		expect(landingB).toBeLessThanOrEqual(BOOST_UPPER_BOUND);
		expect(Math.abs(predictOutputLufs(sourceLufs, landed, histogram) - targetLufs)).toBeLessThan(0.1);
	});

	it("lands on the predictor's root, not the first midpoint inside tolerance", () => {
		const histogram = uniformDbRangeHistogram(-30, -6, 100_000);
		const sourceLufs = -23;
		const targetLufs = sourceLufs - 0.4;
		const anchorsBase = { floorDb: null, pivotDb: -30, limitDb: -3 };
		const tpCap = 40;
		const landingB = bisectBForTargetLufs({
			sourceLufs,
			targetLufs,
			anchors: anchorsBase,
			histogram,
			tpCap,
			neverExpand: true,
			residual: 0,
			tolerance: 0.5,
		});
		const landed: Anchors = {
			...anchorsBase,
			B: landingB,
			peakGainDb: assignPeakGainDb(landingB, tpCap, true),
		};

		expect(landingB).not.toBe(0);
		expect(landingB).toBeCloseTo(-0.4, 1);
		expect(predictOutputLufs(sourceLufs, landed, histogram)).toBeCloseTo(targetLufs, 2);
	});

	it("returns 0 for non-finite sourceLufs", () => {
		expect(
			bisectBForTargetLufs({
				sourceLufs: -Infinity,
				targetLufs: -20,
				anchors: { floorDb: null, pivotDb: -28, limitDb: -6 },
				histogram: uniformDbRangeHistogram(-30, -6, 100_000),
				tpCap: 5,
				neverExpand: false,
				residual: 0,
				tolerance: 0.1,
			}),
		).toBe(0);
	});
});

describe("winner election", () => {
	it("a legal attempt beats an illegal one even when the illegal |lufsErr| is smaller", () => {
		const targetLufs = -21;
		const effectiveTargetTp = -1;
		const illegalCloser = { outputLufs: -20.9, outputTruePeakDb: -1.2, lufsErr: 0.1 };
		const legalFarther = { outputLufs: -21.8, outputTruePeakDb: -2.4, lufsErr: -0.8 };

		expect(attemptBeatsWinner(legalFarther, illegalCloser, targetLufs, effectiveTargetTp)).toBe(true);
		expect(attemptBeatsWinner(illegalCloser, legalFarther, targetLufs, effectiveTargetTp)).toBe(false);
	});

	it("rounds an error onto the 0.01 dB grain before checking it", () => {
		expect(holdsTruePeak(-0.999_61, -1)).toBe(true);
		expect(holdsTruePeak(-0.996, -1)).toBe(true);
		expect(holdsTruePeak(-0.994, -1)).toBe(false);
		expect(holdsTruePeak(-0.9905, -1)).toBe(false);
		expect(holdsTruePeak(-1.5, -1)).toBe(true);
	});

	it("isLegalAttempt requires both axes on the grain", () => {
		expect(isLegalAttempt(-20.004, -6.004, -20, -6)).toBe(true);
		expect(isLegalAttempt(-19.994, -6.004, -20, -6)).toBe(false);
		expect(isLegalAttempt(-20.004, -5.994, -20, -6)).toBe(false);
	});
});

describe("iterateForTargets", () => {
	let workingDirectory: string;
	let scratch: Scratch | undefined;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-solve-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();

		if (scratch !== undefined) {
			await scratch.dispose();
			scratch = undefined;
		}

		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("lands a feasible cross-axis pair inside the never-exceed box", async () => {
		scratch = await Scratch.create();

		const inputPath = join(workingDirectory, "crossaxis.wav");

		await writeWav(inputPath, [makeCrossAxis(3)]);

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});
		const targetLufs = -20;
		const targetTp = -6;

		expect(measurement.integratedLufs).toBeLessThan(targetLufs);
		expect(measurement.truePeakDb).toBeGreaterThan(targetTp);

		const result = await iterateForTargets({
			inputPath,
			scratch,
			sampleRate: measurement.sampleRate,
			channelCount: measurement.channelCount,
			frameCount: measurement.frameCount,
			anchorBase: {
				floorDb: Number.isFinite(measurement.floorAutoDb) ? measurement.floorAutoDb : null,
				pivotDb: Number.isFinite(measurement.pivotAutoDb) ? measurement.pivotAutoDb : -40,
			},
			smoothingMs: 1,
			targetLufs,
			targetTp,
			limitAutoDb: measurement.limitAutoDb,
			sourceLufs: measurement.integratedLufs,
			sourcePeakDb: measurement.truePeakDb,
			maxAttempts: 8,
			tolerance: 0.5,
			neverExpand: false,
			histogram: measurement.detectionHistogram,
			detectionEnvelope: measurement.detectionEnvelope,
		});

		expect(result.winnerOutputLufs).not.toBeNull();
		expect(result.winnerOutputTruePeakDb).not.toBeNull();
		expect(
			isLegalAttempt(
				result.winnerOutputLufs ?? Infinity,
				result.winnerOutputTruePeakDb ?? Infinity,
				targetLufs,
				targetTp,
			),
		).toBe(true);
		expect(Math.abs((result.winnerOutputLufs ?? Infinity) - targetLufs)).toBeLessThan(0.5);

		await result.bestSmoothedEnvelope.close();
	}, 30_000);

	it("lands the uniform-gain endpoint on a downward neverExpand pair", async () => {
		scratch = await Scratch.create();

		const inputPath = join(workingDirectory, "downward.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE * 3, 1, SAMPLE_RATE, 997, dbToLinear(-6)));

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});
		const targetLufs = measurement.integratedLufs - 3;
		const targetTp = measurement.truePeakDb - 1;
		const result = await iterateForTargets({
			inputPath,
			scratch,
			sampleRate: measurement.sampleRate,
			channelCount: measurement.channelCount,
			frameCount: measurement.frameCount,
			anchorBase: {
				floorDb: null,
				pivotDb: Number.isFinite(measurement.pivotAutoDb) ? measurement.pivotAutoDb : -40,
			},
			smoothingMs: 1,
			targetLufs,
			targetTp,
			limitAutoDb: measurement.limitAutoDb,
			sourceLufs: measurement.integratedLufs,
			sourcePeakDb: measurement.truePeakDb,
			maxAttempts: 8,
			tolerance: 0.5,
			neverExpand: true,
			histogram: measurement.detectionHistogram,
			detectionEnvelope: measurement.detectionEnvelope,
		});
		const winner = result.attempts.find(
			(attempt) => attempt.boost === result.bestB && attempt.peakGainDb === result.bestPeakGainDb,
		);

		expect(winner).toBeDefined();
		expect(winner?.peakGainDb).toBe(winner?.boost);
		expect(result.winnerOutputLufs).not.toBeNull();
		expect(Math.abs((result.winnerOutputLufs ?? Infinity) - targetLufs)).toBeLessThan(0.5);
		expect(holdsTruePeak(result.winnerOutputTruePeakDb ?? Infinity, targetTp)).toBe(true);

		await result.bestSmoothedEnvelope.close();
	}, 30_000);

	it("reports converged false for an infeasible pair while holding the ceiling", async () => {
		scratch = await Scratch.create();

		const inputPath = join(workingDirectory, "infeasible.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE * 3, 1, SAMPLE_RATE, 997, dbToLinear(-12)));

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});
		const targetLufs = -80;
		const targetTp = measurement.truePeakDb;
		const result = await iterateForTargets({
			inputPath,
			scratch,
			sampleRate: measurement.sampleRate,
			channelCount: measurement.channelCount,
			frameCount: measurement.frameCount,
			anchorBase: {
				floorDb: null,
				pivotDb: Number.isFinite(measurement.pivotAutoDb) ? measurement.pivotAutoDb : -40,
			},
			smoothingMs: 1,
			targetLufs,
			targetTp,
			limitAutoDb: measurement.limitAutoDb,
			sourceLufs: measurement.integratedLufs,
			sourcePeakDb: measurement.truePeakDb,
			maxAttempts: 6,
			tolerance: 0.5,
			neverExpand: true,
			histogram: measurement.detectionHistogram,
			detectionEnvelope: measurement.detectionEnvelope,
		});

		expect(result.converged).toBe(false);
		expect(result.winnerOutputTruePeakDb).not.toBeNull();
		expect(holdsTruePeak(result.winnerOutputTruePeakDb ?? Infinity, targetTp)).toBe(true);
		expect(result.winnerOutputLufs ?? -Infinity).toBeGreaterThan(targetLufs);

		await result.bestSmoothedEnvelope.close();
	}, 30_000);

	it("reports an attempt's true peak floored", async () => {
		scratch = await Scratch.create();

		const inputPath = join(workingDirectory, "tiny-peak.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-12)));

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});

		vi.spyOn(envelope, "renderEnvelope").mockImplementation(async ({ dest }) => {
			const samples = new Float64Array(measurement.frameCount).fill(1e-12);

			await dest.append(samples, samples.length);
		});

		const result = await iterateForTargets({
			inputPath,
			scratch,
			sampleRate: measurement.sampleRate,
			channelCount: measurement.channelCount,
			frameCount: measurement.frameCount,
			anchorBase: {
				floorDb: null,
				pivotDb: Number.isFinite(measurement.pivotAutoDb) ? measurement.pivotAutoDb : -40,
			},
			smoothingMs: 1,
			targetLufs: measurement.integratedLufs,
			targetTp: measurement.truePeakDb,
			limitAutoDb: measurement.limitAutoDb,
			sourceLufs: measurement.integratedLufs,
			sourcePeakDb: measurement.truePeakDb,
			maxAttempts: 1,
			tolerance: 0.5,
			neverExpand: false,
			histogram: measurement.detectionHistogram,
			detectionEnvelope: measurement.detectionEnvelope,
		});

		expect(result.attempts[0]?.outputTruePeakDb ?? 0).toBeCloseTo(-200, 6);
		expect(result.winnerOutputTruePeakDb ?? 0).toBeCloseTo(-200, 6);

		await result.bestSmoothedEnvelope.close();
	}, 30_000);

	it("closes the elected envelope when a later attempt throws", async () => {
		scratch = await Scratch.create();

		const inputPath = join(workingDirectory, "throw-after-winner.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-12)));

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});
		const originalCreate = SampleFile.create.bind(SampleFile);
		let electedClose: ReturnType<typeof vi.spyOn> | undefined;
		let renderCount = 0;

		vi.spyOn(SampleFile, "create").mockImplementation(async (createScratch, label) => {
			const file = await originalCreate(createScratch, label);

			if (label === "envelope-0") {
				electedClose = vi.spyOn(file, "close");
			}

			return file;
		});
		vi.spyOn(envelope, "renderEnvelope").mockImplementation(async ({ dest }) => {
			renderCount += 1;

			if (renderCount > 1) {
				throw new Error("injected later-attempt failure");
			}

			const samples = new Float64Array(measurement.frameCount).fill(1);

			await dest.append(samples, samples.length);
		});

		await expect(
			iterateForTargets({
				inputPath,
				scratch,
				sampleRate: measurement.sampleRate,
				channelCount: measurement.channelCount,
				frameCount: measurement.frameCount,
				anchorBase: {
					floorDb: null,
					pivotDb: Number.isFinite(measurement.pivotAutoDb) ? measurement.pivotAutoDb : -40,
				},
				smoothingMs: 1,
				targetLufs: measurement.integratedLufs - 0.5,
				targetTp: measurement.truePeakDb - 20,
				limitAutoDb: measurement.limitAutoDb,
				sourceLufs: measurement.integratedLufs,
				sourcePeakDb: measurement.truePeakDb,
				maxAttempts: 2,
				tolerance: 0.01,
				neverExpand: false,
				histogram: measurement.detectionHistogram,
				detectionEnvelope: measurement.detectionEnvelope,
			}),
		).rejects.toThrow(/injected later-attempt failure/);

		expect(electedClose).toBeDefined();
		expect(electedClose).toHaveBeenCalled();
	}, 30_000);

	it("closes the elected envelope when detectionEnvelope.close rejects", async () => {
		scratch = await Scratch.create();

		const inputPath = join(workingDirectory, "detection-close.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-12)));

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});
		const originalCreate = SampleFile.create.bind(SampleFile);
		let electedClose: ReturnType<typeof vi.spyOn> | undefined;
		let renderCount = 0;

		vi.spyOn(measurement.detectionEnvelope, "close").mockRejectedValue(new Error("detection close failed"));
		vi.spyOn(SampleFile, "create").mockImplementation(async (createScratch, label) => {
			const file = await originalCreate(createScratch, label);

			if (label === "envelope-0") {
				electedClose = vi.spyOn(file, "close");
			}

			return file;
		});
		vi.spyOn(envelope, "renderEnvelope").mockImplementation(async ({ dest }) => {
			renderCount += 1;

			if (renderCount > 1) {
				throw new Error("injected later-attempt failure");
			}

			const samples = new Float64Array(measurement.frameCount).fill(1);

			await dest.append(samples, samples.length);
		});

		const thrown: unknown = await iterateForTargets({
			inputPath,
			scratch,
			sampleRate: measurement.sampleRate,
			channelCount: measurement.channelCount,
			frameCount: measurement.frameCount,
			anchorBase: {
				floorDb: null,
				pivotDb: Number.isFinite(measurement.pivotAutoDb) ? measurement.pivotAutoDb : -40,
			},
			smoothingMs: 1,
			targetLufs: measurement.integratedLufs - 0.5,
			targetTp: measurement.truePeakDb - 20,
			limitAutoDb: measurement.limitAutoDb,
			sourceLufs: measurement.integratedLufs,
			sourcePeakDb: measurement.truePeakDb,
			maxAttempts: 2,
			tolerance: 0.01,
			neverExpand: false,
			histogram: measurement.detectionHistogram,
			detectionEnvelope: measurement.detectionEnvelope,
		}).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(thrown).toBeInstanceOf(AggregateError);

		const messages = (thrown as AggregateError).errors.map((error: Error) => error.message);

		expect(messages).toEqual(["injected later-attempt failure", "detection close failed"]);
		expect(electedClose).toBeDefined();
		expect(electedClose).toHaveBeenCalled();
	}, 30_000);

	it("closes the new winner when the previous winner's close rejects", async () => {
		scratch = await Scratch.create();

		const inputPath = join(workingDirectory, "swap-close.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-12)));

		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile: 0.995,
			halfWidth: windowSamplesFromMs(1, SAMPLE_RATE),
		});
		const originalCreate = SampleFile.create.bind(SampleFile);
		let previousClose: ReturnType<typeof vi.spyOn> | undefined;
		let nextClose: ReturnType<typeof vi.spyOn> | undefined;

		vi.spyOn(SampleFile, "create").mockImplementation(async (createScratch, label) => {
			const file = await originalCreate(createScratch, label);

			if (label === "envelope-0") {
				previousClose = vi.spyOn(file, "close").mockRejectedValue(new Error("previous winner close failed"));
			}

			if (label === "envelope-1") {
				nextClose = vi.spyOn(file, "close");
			}

			return file;
		});
		vi.spyOn(envelope, "renderEnvelope").mockImplementation(async ({ dest, label }) => {
			const gain = label === "attempt-0" ? 10 : 1;
			const samples = new Float64Array(measurement.frameCount).fill(gain);

			await dest.append(samples, samples.length);
		});

		await expect(
			iterateForTargets({
				inputPath,
				scratch,
				sampleRate: measurement.sampleRate,
				channelCount: measurement.channelCount,
				frameCount: measurement.frameCount,
				anchorBase: {
					floorDb: null,
					pivotDb: Number.isFinite(measurement.pivotAutoDb) ? measurement.pivotAutoDb : -40,
				},
				smoothingMs: 1,
				targetLufs: measurement.integratedLufs,
				targetTp: measurement.truePeakDb,
				limitAutoDb: measurement.limitAutoDb,
				sourceLufs: measurement.integratedLufs,
				sourcePeakDb: measurement.truePeakDb,
				maxAttempts: 2,
				tolerance: 0.5,
				neverExpand: false,
				histogram: measurement.detectionHistogram,
				detectionEnvelope: measurement.detectionEnvelope,
			}),
		).rejects.toThrow(/previous winner close failed/);

		expect(previousClose).toBeDefined();
		expect(previousClose).toHaveBeenCalled();
		expect(nextClose).toBeDefined();
		expect(nextClose).toHaveBeenCalled();
	}, 30_000);
});
