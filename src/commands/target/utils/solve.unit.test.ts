import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbToLinear } from "../../../utils/db";
import { SampleFile } from "../../../utils/SampleFile";
import { createSine } from "../../../utils/testSignals";
import { Scratch } from "../../../utils/Scratch";
import { WavWriter } from "../../../wav/WavWriter";
import { withWavReader } from "../../utils/withWavReader";
import type { Anchors } from "./curve";
import * as envelope from "./envelope";
import { CELL_COUNT, cellOf, measureSource, type DetectionHistogram, type SourceMeasurement } from "./measureSource";
import {
	attemptBeatsWinner,
	bodySaturationBoost,
	bracketBoost,
	hasConverged,
	holdsTruePeak,
	isLegalAttempt,
	iterateForTargets,
	measuredCapOf,
	nextSearchBoost,
	overshootBoost,
	predictOutputLufs,
	type IterationAttempt,
	type Targets,
} from "./solve";
import { windowSamplesFromMs } from "./window";

const SAMPLE_RATE = 48000;

const histogramWith = (
	frames: ReadonlyArray<{ loudnessDb: number; peakDb: number; energy: number }>,
): DetectionHistogram => {
	const energy = new Float64Array(CELL_COUNT * CELL_COUNT);
	const counts = new Float64Array(CELL_COUNT * CELL_COUNT);

	for (const frame of frames) {
		const cell = cellOf(frame.loudnessDb) * CELL_COUNT + cellOf(frame.peakDb);

		energy[cell] = (energy[cell] ?? 0) + frame.energy;
		counts[cell] = (counts[cell] ?? 0) + 1;
	}

	return { energy, counts, peakLevelCounts: new Float64Array(13_000) };
};

const anchorsOf = (overrides: Partial<Anchors> = {}): Anchors => ({
	floorDb: null,
	pivotDb: -25,
	kneeDb: null,
	limitDb: -6,
	ceilingDb: 0,
	B: 0,
	peakGainDb: 0,
	...overrides,
});

describe("predictOutputLufs", () => {
	it("returns -Infinity for an empty histogram", () => {
		expect(predictOutputLufs(-20, anchorsOf(), histogramWith([]))).toBe(-Infinity);
	});

	it("shifts a body cell by the body gain", () => {
		const histogram = histogramWith([{ loudnessDb: -20.1, peakDb: -20.1, energy: 1 }]);

		expect(predictOutputLufs(-23, anchorsOf({ B: 6, peakGainDb: 6 }), histogram)).toBeCloseTo(-17, 12);
	});

	it("weighs each cell's energy by the power of its gain", () => {
		const histogram = histogramWith([
			{ loudnessDb: -20.1, peakDb: -20.1, energy: 3 },
			{ loudnessDb: -60.1, peakDb: -50.1, energy: 1 },
		]);
		const anchors = anchorsOf({ floorDb: -45, B: 10, peakGainDb: 10 });

		expect(predictOutputLufs(-23, anchors, histogram)).toBeCloseTo(-23 + 10 * Math.log10((3 * 10 + 1) / 4), 12);
	});

	it("never falls as the body gain rises", () => {
		const frames: Array<{ loudnessDb: number; peakDb: number; energy: number }> = [];

		for (let loudnessDb = -70; loudnessDb <= -5; loudnessDb += 2.3) {
			for (let peakDb = -40; peakDb <= 1; peakDb += 1.7) {
				frames.push({ loudnessDb, peakDb, energy: dbToLinear(loudnessDb) * (1 + ((peakDb + 40) % 3)) });
			}
		}

		const histogram = histogramWith(frames);
		const ceilingDb = -1;
		const limitDb = -6;
		let previous = -Infinity;

		for (let boost = -50; boost <= 50; boost += 0.25) {
			const predicted = predictOutputLufs(
				-23,
				anchorsOf({
					floorDb: -45,
					kneeDb: -15,
					limitDb,
					ceilingDb,
					B: boost,
					peakGainDb: Math.min(ceilingDb - limitDb, boost + 3),
				}),
				histogram,
			);

			expect(predicted).toBeGreaterThanOrEqual(previous);
			previous = predicted;
		}
	});
});

describe("bracketBoost", () => {
	const sourceLufs = -50;
	const predictOn =
		(histogram: DetectionHistogram, floorDb: number | null) =>
		(boost: number): number =>
			predictOutputLufs(sourceLufs, anchorsOf({ floorDb, B: boost, peakGainDb: boost }), histogram);

	it("brackets a target 40 dB above the starting body gain", () => {
		const predict = predictOn(histogramWith([{ loudnessDb: -50.1, peakDb: -47.1, energy: 1 }]), null);
		const bracket = bracketBoost({
			predict,
			targetLufs: sourceLufs + 40,
			startB: 0,
			maxB: Number.POSITIVE_INFINITY,
			tolerance: 0.5,
		});

		expect(bracket).toEqual({ kind: "bracket", lower: 18, upper: 42 });
		expect(predict(18)).toBeLessThan(sourceLufs + 40);
		expect(predict(42)).toBeGreaterThanOrEqual(sourceLufs + 40);
	});

	it("brackets a target below the starting body gain", () => {
		const predict = predictOn(histogramWith([{ loudnessDb: -50.1, peakDb: -47.1, energy: 1 }]), null);

		expect(
			bracketBoost({
				predict,
				targetLufs: sourceLufs - 10,
				startB: 0,
				maxB: Number.POSITIVE_INFINITY,
				tolerance: 0.5,
			}),
		).toEqual({
			kind: "bracket",
			lower: -18,
			upper: -6,
		});
	});

	it("stops at the cap when the target lies past it", () => {
		const predict = predictOn(histogramWith([{ loudnessDb: -50.1, peakDb: -47.1, energy: 1 }]), null);

		expect(bracketBoost({ predict, targetLufs: sourceLufs + 40, startB: 0, maxB: 30, tolerance: 0.5 })).toEqual({
			kind: "capped",
			boost: 30,
		});
		expect(bracketBoost({ predict, targetLufs: sourceLufs + 40, startB: 35, maxB: 30, tolerance: 0.5 })).toEqual({
			kind: "capped",
			boost: 30,
		});
	});

	it("stops where the predicted loudness stops rising when no cap applies", () => {
		const predict = predictOn(histogramWith([{ loudnessDb: -60.1, peakDb: -50.1, energy: 1 }]), -45);

		expect(
			bracketBoost({
				predict,
				targetLufs: sourceLufs + 10,
				startB: 10,
				maxB: Number.POSITIVE_INFINITY,
				tolerance: 0.5,
			}),
		).toEqual({ kind: "capped", boost: 16 });
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

	it("reads an unmeasurable output figure as below any target", () => {
		const unmeasurable = { outputLufs: null, outputTruePeakDb: null };
		const measured = { outputLufs: -16.4, outputTruePeakDb: -1.3 };

		expect(isLegalAttempt(null, null, -16, -1)).toBe(true);
		expect(isLegalAttempt(null, -0.5, -16, -1)).toBe(false);
		expect(attemptBeatsWinner(unmeasurable, measured, -16, -1)).toBe(false);
		expect(attemptBeatsWinner(measured, unmeasurable, -16, -1)).toBe(true);
		expect(attemptBeatsWinner(unmeasurable, measured, undefined, -1)).toBe(false);
		expect(attemptBeatsWinner(measured, unmeasurable, undefined, -1)).toBe(true);
	});
});

const attemptOf = (fields: Partial<IterationAttempt>): IterationAttempt => ({
	boost: 0,
	peakGainDb: null,
	ceilingDb: -1,
	lufsErr: null,
	peakErr: null,
	outputLufs: null,
	outputTruePeakDb: null,
	outputLra: null,
	...fields,
});

describe("nextSearchBoost", () => {
	it("splits the bracket with an unmeasurable attempt on the side under the target", () => {
		const attempts = [attemptOf({ boost: -30 }), attemptOf({ boost: 2, outputLufs: -12 })];

		expect(nextSearchBoost(attempts, 5, -16)).toBe(-14);
	});
});

describe("bodySaturationBoost", () => {
	const anchorsAt = (boost: number): Anchors => anchorsOf({ pivotDb: -25, ceilingDb: 0, B: boost, peakGainDb: boost });

	it("returns the smallest body gain past which a 6 dB step lifts the body by under a tenth of the tolerance", () => {
		const histogram = histogramWith([
			{ loudnessDb: -20.1, peakDb: -10.1, energy: 1 },
			{ loudnessDb: -60.1, peakDb: -90.1, energy: 1_000 },
		]);
		const boost = bodySaturationBoost({ anchorsAt, histogram, startB: -40, tolerance: 0.5 });

		expect(boost).toBeGreaterThanOrEqual(10.2);
		expect(boost).toBeLessThanOrEqual(10.21);
		expect(bodySaturationBoost({ anchorsAt, histogram, startB: 300, tolerance: 0.5 })).toBeCloseTo(boost, 1);
	});

	it("returns +Infinity when no frame reaches the pivot", () => {
		const histogram = histogramWith([{ loudnessDb: -60.1, peakDb: -50.1, energy: 1 }]);

		expect(bodySaturationBoost({ anchorsAt, histogram, startB: 0, tolerance: 0.5 })).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("measuredCapOf", () => {
	it("caps at the lower body gain of a pair whose higher gain landed quieter", () => {
		const attempts = [
			attemptOf({ boost: 10, outputLufs: -18 }),
			attemptOf({ boost: 30, outputLufs: -17.5 }),
			attemptOf({ boost: 20, outputLufs: -17 }),
		];

		expect(measuredCapOf(attempts)).toBe(20);
	});

	it("returns +Infinity while louder attempts follow higher body gains", () => {
		const attempts = [attemptOf({ boost: 10, outputLufs: -18 }), attemptOf({ boost: 20, outputLufs: -17 })];

		expect(measuredCapOf(attempts)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("overshootBoost", () => {
	it("steps the lowest body gain down by its overshoot over the slope between the two lowest attempts", () => {
		const attempts = [attemptOf({ boost: 50, outputLufs: -15.5 }), attemptOf({ boost: 48, outputLufs: -15.8 })];

		expect(overshootBoost(attempts, -16)).toBeCloseTo(48 - 0.2 / 0.15, 12);
	});

	it("steps down 1 dB from one attempt and doubles the step while the slope stays under 0.01 LU/dB", () => {
		const first = attemptOf({ boost: 50, outputLufs: -15.5 });
		const second = attemptOf({ boost: 49, outputLufs: -15.505 });
		const third = attemptOf({ boost: 47, outputLufs: -15.506 });

		expect(overshootBoost([first], -16)).toBe(49);
		expect(overshootBoost([first, second], -16)).toBe(47);
		expect(overshootBoost([first, second, third], -16)).toBe(43);
	});

	it("returns null once an attempt lands at or under the target", () => {
		const attempts = [attemptOf({ boost: 50, outputLufs: -15.5 }), attemptOf({ boost: 40, outputLufs: -16.004 })];

		expect(overshootBoost(attempts, -16)).toBeNull();
		expect(overshootBoost([], -16)).toBeNull();
	});
});

describe("hasConverged", () => {
	it("never converges on the true peak when --lufs is given and the loudness is unmeasurable", () => {
		const attempt = attemptOf({ outputTruePeakDb: -1.1, peakErr: -0.1 });

		expect(hasConverged(attempt, -16, -1, 0.5)).toBe(false);
	});

	it("converges on the true-peak error under --tp alone", () => {
		const attempt = attemptOf({ outputLufs: -30, outputTruePeakDb: -1.2, peakErr: -0.2 });

		expect(hasConverged(attempt, undefined, -1, 0.5)).toBe(true);
	});
});

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

interface MeasuredRun {
	readonly inputPath: string;
	readonly activeScratch: Scratch;
	readonly measurement: SourceMeasurement & { readonly truePeakDb: number };
}

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

	const measureWav = async (name: string, channels: Array<Float64Array>): Promise<MeasuredRun> => {
		const activeScratch = await Scratch.create();

		scratch = activeScratch;

		const inputPath = join(workingDirectory, name);

		await writeWav(inputPath, channels);

		const measurement = await withWavReader(inputPath, async (source) =>
			measureSource({
				source,
				scratch: activeScratch,
				limitPercentile: 0.995,
				halfWidthOf: (sampleRate) => windowSamplesFromMs(1, sampleRate),
			}),
		);
		const { truePeakDb } = measurement;

		if (truePeakDb === null) {
			throw new Error(`"${name}" has no measurable true peak`);
		}

		return { inputPath, activeScratch, measurement: { ...measurement, truePeakDb } };
	};

	const iterateOn = async (
		run: MeasuredRun,
		targets: Targets,
		options: { kneeDb?: number; neverExpand?: boolean; maxAttempts?: number; tolerance?: number } = {},
	) => {
		const { measurement } = run;
		const pivotDb = Number.isFinite(measurement.pivotAutoDb) ? measurement.pivotAutoDb : -40;

		return iterateForTargets({
			inputPath: run.inputPath,
			scratch: run.activeScratch,
			sampleRate: measurement.sampleRate,
			channelCount: measurement.channelCount,
			weights: measurement.weights,
			frameCount: measurement.frameCount,
			outputBitDepth: "32f",
			anchorBase: {
				floorDb: Number.isFinite(measurement.floorAutoDb) ? Math.min(measurement.floorAutoDb, pivotDb - 6) : null,
				pivotDb,
				kneeDb: options.kneeDb ?? null,
				limitDb: Math.min(measurement.limitAutoDb, measurement.truePeakDb),
			},
			smoothingMs: 1,
			...targets,
			sourceLufs: measurement.integratedLufs,
			maxAttempts: options.maxAttempts ?? 8,
			tolerance: options.tolerance ?? 0.5,
			neverExpand: options.neverExpand ?? false,
			histogram: measurement.detectionHistogram,
			loudnessEnvelope: measurement.loudnessEnvelope,
			peakEnvelope: measurement.peakEnvelope,
		});
	};

	it("lands a feasible cross-axis pair inside the never-exceed box", async () => {
		const run = await measureWav("crossaxis.wav", [makeCrossAxis(3)]);
		const targetLufs = -20;
		const targetTp = -6;

		expect(run.measurement.integratedLufs).toBeLessThan(targetLufs);
		expect(run.measurement.truePeakDb).toBeGreaterThan(targetTp);

		const result = await iterateOn(run, { targetLufs, targetTp });

		expect(isLegalAttempt(result.winnerOutputLufs, result.winnerOutputTruePeakDb, targetLufs, targetTp)).toBe(true);
		expect(Math.abs((result.winnerOutputLufs ?? Infinity) - targetLufs)).toBeLessThan(0.5);

		await result.bestSmoothedEnvelope.close();
	}, 30_000);

	it("reports no peak gain and no peak error in every attempt when only loudness is targeted", async () => {
		const run = await measureWav("lufs-only.wav", [makeCrossAxis(3)]);
		const result = await iterateOn(run, { targetLufs: -20, targetTp: undefined });

		expect(result.attempts.length).toBeGreaterThan(0);

		for (const attempt of result.attempts) {
			expect(attempt.peakGainDb).toBeNull();
			expect(attempt.peakErr).toBeNull();
			expect(attempt.lufsErr).not.toBeNull();
			expect(attempt.ceilingDb).toBeLessThanOrEqual(0);
		}

		expect(result.converged).toBe(true);
		expect(holdsTruePeak(result.winnerOutputTruePeakDb, 0)).toBe(true);

		await result.bestSmoothedEnvelope.close();
	}, 30_000);

	it("sets the body gain to the ceiling over the limit when only the true peak is targeted", async () => {
		const run = await measureWav("tp-only.wav", [makeCrossAxis(3)]);
		const targetTp = -6;
		const limitDb = Math.min(run.measurement.limitAutoDb, run.measurement.truePeakDb);
		const result = await iterateOn(run, { targetLufs: undefined, targetTp });

		expect(result.attempts.length).toBeGreaterThan(0);
		expect(result.attempts[0]?.boost).toBe(targetTp - limitDb);

		for (const attempt of result.attempts) {
			expect(attempt.boost).toBe(attempt.ceilingDb - limitDb);
			expect(attempt.lufsErr).toBeNull();
			expect(attempt.peakErr).not.toBeNull();
		}

		expect(result.converged).toBe(true);
		expect(holdsTruePeak(result.winnerOutputTruePeakDb, targetTp)).toBe(true);

		await result.bestSmoothedEnvelope.close();
	}, 30_000);

	it("keeps the peak gain on the body gain on a downward neverExpand pair", async () => {
		const run = await measureWav("downward.wav", createSine(SAMPLE_RATE * 3, 1, SAMPLE_RATE, 997, dbToLinear(-6)));
		const targetLufs = run.measurement.integratedLufs - 3;
		const targetTp = run.measurement.truePeakDb - 1;
		const result = await iterateOn(
			run,
			{ targetLufs, targetTp },
			{ kneeDb: run.measurement.truePeakDb - 12, neverExpand: true },
		);
		const winner = result.attempts.find((attempt) => attempt.boost === result.bestB);

		expect(winner).toBeDefined();
		expect(winner?.peakGainDb).toBe(winner?.boost);
		expect(Math.abs((result.winnerOutputLufs ?? Infinity) - targetLufs)).toBeLessThan(0.5);
		expect(holdsTruePeak(result.winnerOutputTruePeakDb, targetTp)).toBe(true);

		await result.bestSmoothedEnvelope.close();
	}, 30_000);

	it("reports an attempt's true peak without a floor", async () => {
		const run = await measureWav("tiny-peak.wav", createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-12)));

		vi.spyOn(envelope, "renderEnvelope").mockImplementation(async ({ dest }) => {
			const samples = new Float64Array(run.measurement.frameCount).fill(1e-12);

			await dest.append(samples, samples.length);
		});

		const result = await iterateOn(
			run,
			{ targetLufs: run.measurement.integratedLufs, targetTp: run.measurement.truePeakDb },
			{ maxAttempts: 1 },
		);

		expect(Math.abs((result.attempts[0]?.outputTruePeakDb ?? 0) - -252)).toBeLessThan(0.05);
		expect(Math.abs((result.winnerOutputTruePeakDb ?? 0) - -252)).toBeLessThan(0.05);

		await result.bestSmoothedEnvelope.close();
	}, 30_000);

	const spyOnEnvelopeClose = (labels: ReadonlyArray<string>, rejecting: ReadonlyArray<string> = []) => {
		const originalCreate = SampleFile.create.bind(SampleFile);
		const closes = new Map<string, unknown>();

		vi.spyOn(SampleFile, "create").mockImplementation(async (createScratch, label) => {
			const file = await originalCreate(createScratch, label);

			if (rejecting.includes(label)) {
				closes.set(label, vi.spyOn(file, "close").mockRejectedValue(new Error(`${label} close failed`)));
			} else if (labels.includes(label)) {
				closes.set(label, vi.spyOn(file, "close"));
			}

			return file;
		});

		return closes;
	};

	const renderFailingAfterFirst = (frameCount: number): void => {
		let renderCount = 0;

		vi.spyOn(envelope, "renderEnvelope").mockImplementation(async ({ dest }) => {
			renderCount += 1;

			if (renderCount > 1) {
				throw new Error("injected later-attempt failure");
			}

			const samples = new Float64Array(frameCount).fill(1);

			await dest.append(samples, samples.length);
		});
	};

	it("closes the elected envelope when a later attempt throws", async () => {
		const run = await measureWav(
			"throw-after-winner.wav",
			createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-12)),
		);
		const closes = spyOnEnvelopeClose(["envelope-0"]);

		renderFailingAfterFirst(run.measurement.frameCount);

		await expect(
			iterateOn(
				run,
				{ targetLufs: run.measurement.integratedLufs - 0.5, targetTp: run.measurement.truePeakDb - 20 },
				{ maxAttempts: 2, tolerance: 0.01 },
			),
		).rejects.toThrow(/injected later-attempt failure/);

		expect(closes.get("envelope-0")).toHaveBeenCalled();
	}, 30_000);

	it("closes the elected envelope when the peak envelope's close rejects", async () => {
		const run = await measureWav("peak-close.wav", createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-12)));
		const closes = spyOnEnvelopeClose(["envelope-0"]);

		vi.spyOn(run.measurement.peakEnvelope, "close").mockRejectedValue(new Error("peak close failed"));
		renderFailingAfterFirst(run.measurement.frameCount);

		await expect(
			iterateOn(
				run,
				{ targetLufs: run.measurement.integratedLufs - 0.5, targetTp: run.measurement.truePeakDb - 20 },
				{ maxAttempts: 2, tolerance: 0.01 },
			),
		).rejects.toThrow(/peak close failed/);

		expect(closes.get("envelope-0")).toHaveBeenCalled();
	}, 30_000);

	it("closes the new winner when the previous winner's close rejects", async () => {
		const run = await measureWav("swap-close.wav", createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-12)));
		const closes = spyOnEnvelopeClose(["envelope-1"], ["envelope-0"]);
		let renderCount = 0;

		vi.spyOn(envelope, "renderEnvelope").mockImplementation(async ({ dest }) => {
			const gain = renderCount === 0 ? 10 : 1;

			renderCount++;

			const samples = new Float64Array(run.measurement.frameCount).fill(gain);

			await dest.append(samples, samples.length);
		});

		await expect(
			iterateOn(
				run,
				{ targetLufs: run.measurement.integratedLufs, targetTp: run.measurement.truePeakDb },
				{ maxAttempts: 2 },
			),
		).rejects.toThrow(/envelope-0 close failed/);

		expect(closes.get("envelope-0")).toHaveBeenCalled();
		expect(closes.get("envelope-1")).toHaveBeenCalled();
	}, 30_000);
});
