import { InvalidArgumentError, type Command } from "commander";
import { Scratch } from "../../utils/Scratch";
import { WavReader } from "../../wav/WavReader";
import { copyUnchanged } from "../utils/copyUnchanged";
import { withWavWriter } from "../utils/withWavWriter";
import { forEachEnvelopedBlock } from "./utils/apply";
import { measureSource } from "./utils/measureSource";
import { iterateForTargets } from "./utils/solve";
import { windowSamplesFromMs } from "./utils/window";
import type { IterationAttempt } from "./utils/solve";
import type { SampleFile } from "../../utils/SampleFile";

interface TargetOptions {
	readonly output: string;
	readonly lufs?: number;
	readonly tp?: number;
	readonly pivot?: number;
	readonly floor?: number;
	readonly limitPercentile?: number;
	readonly limitDb?: number;
	readonly smoothing?: number;
	readonly neverExpand?: boolean;
	readonly tolerance?: number;
	readonly scratchDir?: string;
}

const LABEL_WIDTH = 18;
const DEFAULT_TARGET_LUFS = -16;
const DEFAULT_LIMIT_PERCENTILE = 0.995;
const DEFAULT_SMOOTHING_MS = 1;
const DEFAULT_TOLERANCE = 0.5;
const FLOOR_PIVOT_EPSILON_DB = 0.01;
const PIVOT_FALLBACK_DB = -40;
const TARGET_LUFS_STEP = 0.1;

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const parseFinite = (name: string, value: string, isValid: (parsed: number) => boolean, message: string): number => {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || !isValid(parsed)) {
		throw new InvalidArgumentError(`${name} ${message}, received ${value}`);
	}

	return parsed;
};

const assertBounded = (
	name: string,
	value: number | undefined,
	isValid: (parsed: number) => boolean,
	message: string,
): void => {
	if (value !== undefined && !isValid(value)) {
		throw new InvalidArgumentError(`${name} ${message}, received ${value}`);
	}
};

const isMultipleOf = (value: number, step: number): boolean => {
	const valueDecimals = (value.toString().split(".")[1] ?? "").length;
	const stepDecimals = (step.toString().split(".")[1] ?? "").length;
	const decimals = valueDecimals > stepDecimals ? valueDecimals : stepDecimals;
	const scaledValue = Number.parseInt(value.toFixed(decimals).replace(".", ""), 10);
	const scaledStep = Number.parseInt(step.toFixed(decimals).replace(".", ""), 10);

	return scaledValue % scaledStep === 0;
};

const LUFS_RANGE = `must be in [-50, 0] in steps of ${TARGET_LUFS_STEP}`;

const isLufs = (value: number): boolean =>
	Number.isFinite(value) && value >= -50 && value <= 0 && isMultipleOf(value, TARGET_LUFS_STEP);

const parseLufs = (value: string): number => parseFinite("lufs", value, isLufs, LUFS_RANGE);

const isBoundedNegativeDb = (value: number, lowerBound: number): boolean =>
	Number.isFinite(value) && value >= lowerBound && value < 0;

const boundedNegativeDbRange = (lowerBound: number): string => `must be in [${lowerBound}, 0)`;

const parseNegativeDb =
	(name: string, lowerBound: number) =>
	(value: string): number =>
		parseFinite(name, value, (parsed) => isBoundedNegativeDb(parsed, lowerBound), boundedNegativeDbRange(lowerBound));

const assertBoundedNegativeDb = (name: string, lowerBound: number, value: number | undefined): void =>
	assertBounded(name, value, (parsed) => isBoundedNegativeDb(parsed, lowerBound), boundedNegativeDbRange(lowerBound));

const LIMIT_PERCENTILE_RANGE = "must be in [0.5, 1.0]";

const isLimitPercentile = (value: number): boolean => Number.isFinite(value) && value >= 0.5 && value <= 1;

const parseLimitPercentile = (value: string): number =>
	parseFinite("limit-percentile", value, isLimitPercentile, LIMIT_PERCENTILE_RANGE);

const SMOOTHING_RANGE = "must be in [0.01, 200]";

const isSmoothing = (value: number): boolean => Number.isFinite(value) && value >= 0.01 && value <= 200;

const parseSmoothing = (value: string): number => parseFinite("smoothing", value, isSmoothing, SMOOTHING_RANGE);

const TOLERANCE_RANGE = "must be in (0, 6]";

const isTolerance = (value: number): boolean => Number.isFinite(value) && value > 0 && value <= 6;

const parseTolerance = (value: string): number => parseFinite("tolerance", value, isTolerance, TOLERANCE_RANGE);

const formatAttempt = (attempt: IterationAttempt, attemptIndex: number): string =>
	[
		`attempt ${attemptIndex + 1}`,
		`B ${attempt.boost.toFixed(4)}`,
		`peakGainDb ${attempt.peakGainDb.toFixed(4)}`,
		`lufsErr ${attempt.lufsErr.toFixed(4)}`,
		`peakErr ${attempt.peakErr.toFixed(4)}`,
	].join("    ");

const applyEnvelopeAndWrite = async (inputPath: string, outputPath: string, envelope: SampleFile): Promise<void> => {
	await withWavWriter(inputPath, outputPath, async (reader, writer) => {
		await reader.close();
		await forEachEnvelopedBlock(inputPath, envelope, async (channels) => {
			await writer.write(channels);
		});
	});
};

const sampleRateOf = async (path: string): Promise<number> => {
	const reader = await WavReader.open(path);

	try {
		const { sampleRate, channelCount } = reader.format;

		if (channelCount > 2) {
			throw new Error(
				`${path}: ${channelCount} channels unsupported; loudness measurement beyond stereo needs BS.1770 Table 3 channel weighting`,
			);
		}

		return sampleRate;
	} finally {
		await reader.close();
	}
};

export const target = async (inputPath: string, options: TargetOptions): Promise<void> => {
	const targetLufs = options.lufs ?? DEFAULT_TARGET_LUFS;
	const limitPercentile = options.limitPercentile ?? DEFAULT_LIMIT_PERCENTILE;
	const smoothingMs = options.smoothing ?? DEFAULT_SMOOTHING_MS;
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
	const neverExpand = options.neverExpand === true;

	assertBounded("lufs", options.lufs, isLufs, LUFS_RANGE);
	assertBoundedNegativeDb("tp", -24, options.tp);
	assertBoundedNegativeDb("pivot", -80, options.pivot);
	assertBoundedNegativeDb("floor", -100, options.floor);
	assertBoundedNegativeDb("limit-db", -60, options.limitDb);
	assertBounded("limit-percentile", options.limitPercentile, isLimitPercentile, LIMIT_PERCENTILE_RANGE);
	assertBounded("smoothing", options.smoothing, isSmoothing, SMOOTHING_RANGE);
	assertBounded("tolerance", options.tolerance, isTolerance, TOLERANCE_RANGE);

	if (options.floor !== undefined && options.pivot !== undefined && options.floor >= options.pivot) {
		throw new InvalidArgumentError("floor must be < pivot when both are supplied");
	}

	const scratch = await Scratch.create(options.scratchDir);
	const errors: Array<unknown> = [];
	let winningEnvelope: SampleFile | undefined;

	try {
		const measurement = await measureSource({
			inputPath,
			scratch,
			limitPercentile,
			halfWidth: windowSamplesFromMs(smoothingMs, await sampleRateOf(inputPath)),
		});

		winningEnvelope = measurement.detectionEnvelope;

		if (!Number.isFinite(measurement.integratedLufs)) {
			await copyUnchanged(inputPath, options.output);
			process.stderr.write("source has no measurable loudness; passed through unchanged\n");
		} else {
			let effectivePivotDb: number;

			if (options.pivot !== undefined) {
				effectivePivotDb = options.pivot;
			} else if (Number.isFinite(measurement.pivotAutoDb)) {
				effectivePivotDb = measurement.pivotAutoDb;
			} else {
				effectivePivotDb = PIVOT_FALLBACK_DB;
			}

			let effectiveFloorDb: number | null;

			if (options.floor !== undefined) {
				effectiveFloorDb = options.floor;
			} else if (Number.isFinite(measurement.floorAutoDb)) {
				effectiveFloorDb = measurement.floorAutoDb;
			} else {
				effectiveFloorDb = null;
			}

			if (effectiveFloorDb !== null && effectiveFloorDb >= effectivePivotDb) {
				effectiveFloorDb = effectivePivotDb - FLOOR_PIVOT_EPSILON_DB;
			}

			const result = await iterateForTargets({
				inputPath,
				scratch,
				sampleRate: measurement.sampleRate,
				channelCount: measurement.channelCount,
				frameCount: measurement.frameCount,
				anchorBase: { floorDb: effectiveFloorDb, pivotDb: effectivePivotDb },
				smoothingMs,
				targetLufs,
				targetTp: options.tp,
				limitDbOverride: options.limitDb,
				limitAutoDb: measurement.limitAutoDb,
				sourceLufs: measurement.integratedLufs,
				sourcePeakDb: measurement.truePeakDb,
				tolerance,
				neverExpand,
				histogram: measurement.detectionHistogram,
				detectionEnvelope: measurement.detectionEnvelope,
				onAttempt: (attempt, attemptIndex) => {
					process.stderr.write(`${formatAttempt(attempt, attemptIndex)}\n`);
				},
			});

			winningEnvelope = result.bestSmoothedEnvelope;

			await applyEnvelopeAndWrite(inputPath, options.output, result.bestSmoothedEnvelope);

			const outputLufs = result.winnerOutputLufs;
			const outputTruePeak = result.winnerOutputTruePeakDb;
			const outputLra = result.winnerOutputLra;

			process.stdout.write(
				`${[
					alignedLine("output integrated", outputLufs === null ? "n/a" : `${outputLufs.toFixed(2)} LUFS`),
					alignedLine("output true peak", outputTruePeak === null ? "n/a" : `${outputTruePeak.toFixed(2)} dBTP`),
					alignedLine("loudness range", outputLra === null ? "n/a" : `${outputLra.toFixed(2)} LU`),
					alignedLine("B", `${result.bestB.toFixed(4)} dB`),
					alignedLine("peakGainDb", `${result.bestPeakGainDb.toFixed(4)} dB`),
					alignedLine("converged", String(result.converged)),
					alignedLine("output", options.output),
				].join("\n")}\n`,
			);
		}
	} catch (error: unknown) {
		errors.push(error);
	} finally {
		try {
			await winningEnvelope?.close();
		} catch (error: unknown) {
			errors.push(error);
		}

		try {
			await scratch.dispose();
		} catch (error: unknown) {
			errors.push(error);
		}
	}

	if (errors.length === 1) {
		throw errors[0];
	}

	if (errors.length > 1) {
		throw new AggregateError(errors, "Target and cleanup failed");
	}
};

export const addTargetCommand = (program: Command): void => {
	const command = program.command("target");

	command.description("Fit a WAV file to a joint integrated-loudness and true-peak target");
	command.argument("<input>", "input WAV path");
	command.requiredOption("-o, --output <path>", "output WAV path");
	command.option("--lufs <n>", "target integrated loudness in LUFS", parseLufs, DEFAULT_TARGET_LUFS);
	command.option("--tp <dBTP>", "target true peak in dBTP", parseNegativeDb("tp", -24));
	command.option("--pivot <dB>", "body-anchor level in dB", parseNegativeDb("pivot", -80));
	command.option("--floor <dB>", "noise-gate level in dB", parseNegativeDb("floor", -100));
	command.option(
		"--limit-percentile <p>",
		"top 1-p fraction of detection samples to brick-wall",
		parseLimitPercentile,
		DEFAULT_LIMIT_PERCENTILE,
	);
	command.option("--limit-db <dB>", "limit-anchor override in dB", parseNegativeDb("limit-db", -60));
	command.option("--smoothing <ms>", "envelope time constant in milliseconds", parseSmoothing, DEFAULT_SMOOTHING_MS);
	command.option("--never-expand", "keep the upper arm flat or compressive");
	command.option("--tolerance <dB>", "LUFS exit threshold in dB", parseTolerance, DEFAULT_TOLERANCE);
	command.option("--scratch-dir <path>", "directory for temporary sample files");
	command.action(target);
};
