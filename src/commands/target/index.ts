import { InvalidArgumentError, type Command } from "commander";
import { isMultipleOf } from "../../utils/multipleOf";
import { Scratch } from "../../utils/Scratch";
import { scratchDirectoryOf, withAudioInput, type AudioInput } from "../utils/AudioInput";
import { copyUnchanged } from "../utils/copyUnchanged";
import { sinkOf, summaryStreamOf } from "../utils/sinks";
import { withWavWriter } from "../utils/withWavWriter";
import { forEachEnvelopedBlock } from "./utils/apply";
import { measureSource } from "./utils/measureSource";
import { iterateForTargets } from "./utils/solve";
import { windowSamplesFromMs } from "./utils/window";
import type { IterationAttempt, Targets } from "./utils/solve";
import type { SampleFile } from "../../utils/SampleFile";
import type { WavSink } from "../../wav/WavWriter";

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

const errorFieldsOf = (label: string, error: number | null): Array<string> =>
	error === null ? [] : [`${label} ${error.toFixed(4)}`];

const formatAttempt = (attempt: IterationAttempt, attemptIndex: number): string =>
	[
		`attempt ${attemptIndex + 1}`,
		`B ${attempt.boost.toFixed(4)}`,
		`peakGainDb ${attempt.peakGainDb.toFixed(4)}`,
		...errorFieldsOf("lufsErr", attempt.lufsErr),
		...errorFieldsOf("peakErr", attempt.peakErr),
	].join("    ");

const targetsOf = (lufs: number | undefined, tp: number | undefined): Targets => {
	if (lufs !== undefined) {
		return { targetLufs: lufs, targetTp: tp };
	}

	if (tp !== undefined) {
		return { targetLufs: undefined, targetTp: tp };
	}

	throw new InvalidArgumentError("at least one of --lufs and --tp is required");
};

const figureOf = (value: number | null, unit: string): string =>
	value === null ? "n/a" : `${value.toFixed(2)} ${unit}`;

const applyEnvelopeAndWrite = async (replayPath: string, sink: WavSink, envelope: SampleFile): Promise<void> => {
	await withWavWriter(replayPath, sink, async (reader, writer) => {
		await reader.close();
		await forEachEnvelopedBlock(replayPath, envelope, async (channels) => {
			await writer.write(channels);
		});
	});
};

const fitInput = async (
	input: AudioInput,
	options: TargetOptions,
	settings: {
		readonly targets: Targets;
		readonly limitPercentile: number;
		readonly smoothingMs: number;
		readonly tolerance: number;
		readonly neverExpand: boolean;
	},
): Promise<void> => {
	const { targets, limitPercentile, smoothingMs, tolerance, neverExpand } = settings;
	const scratch = await Scratch.create(options.scratchDir);
	const errors: Array<unknown> = [];
	let winningEnvelope: SampleFile | undefined;

	try {
		const measurement = await input.withFirstPass(async (source) =>
			measureSource({
				source,
				scratch,
				limitPercentile,
				halfWidthOf: (sampleRate) => windowSamplesFromMs(smoothingMs, sampleRate),
			}),
		);

		winningEnvelope = measurement.detectionEnvelope;

		if (!Number.isFinite(measurement.integratedLufs)) {
			await copyUnchanged(input.replayPath(), sinkOf(options.output));
			process.stderr.write("source has no measurable loudness; passed through unchanged\n");
		} else {
			let effectivePivotDb: number;

			if (options.pivot !== undefined) {
				effectivePivotDb = options.pivot;
			} else if (Number.isFinite(measurement.pivotAutoDb)) {
				effectivePivotDb = measurement.pivotAutoDb;
			} else {
				effectivePivotDb = PIVOT_FALLBACK_DB;
				process.stderr.write(
					`pivot auto-derivation produced no considered LRA blocks; falling back to ${PIVOT_FALLBACK_DB} dB. Supply --pivot explicitly for tighter control on short or near-silent sources\n`,
				);
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
				inputPath: input.replayPath(),
				scratch,
				sampleRate: measurement.sampleRate,
				channelCount: measurement.channelCount,
				weights: measurement.weights,
				frameCount: measurement.frameCount,
				anchorBase: { floorDb: effectiveFloorDb, pivotDb: effectivePivotDb },
				smoothingMs,
				...targets,
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

			await applyEnvelopeAndWrite(input.replayPath(), sinkOf(options.output), result.bestSmoothedEnvelope);

			summaryStreamOf(options.output).write(
				`${[
					alignedLine("output integrated", figureOf(result.winnerOutputLufs, "LUFS")),
					alignedLine("output true peak", figureOf(result.winnerOutputTruePeakDb, "dBTP")),
					alignedLine("loudness range", figureOf(result.winnerOutputLra, "LU")),
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

export const target = async (inputPath: string, options: TargetOptions): Promise<void> => {
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

	const targets = targetsOf(options.lufs, options.tp);

	await withAudioInput(inputPath, { replayable: true, scratchDirectory: options.scratchDir }, async (input) =>
		fitInput(input, options, { targets, limitPercentile, smoothingMs, tolerance, neverExpand }),
	);
};

export const addTargetCommand = (program: Command): void => {
	const command = program.command("target");

	command.description("Fit a WAV file to an integrated-loudness target, a true-peak target, or both");
	command.argument("<input>", "input WAV path, or - for stdin");
	command.requiredOption("-o, --output <path>", "output WAV path, or - for stdout");
	command.option(
		"--lufs <n>",
		"target integrated loudness in LUFS; without it the body gain follows the limit gain",
		parseLufs,
	);
	command.option(
		"--tp <dBTP>",
		"target true peak in dBTP; without it the limit gain follows the body gain",
		parseNegativeDb("tp", -24),
	);
	command.option("--pivot <dB>", "body-anchor level in dB", parseNegativeDb("pivot", -80));
	command.option("--floor <dB>", "noise-gate level in dB", parseNegativeDb("floor", -100));
	command.option(
		"--limit-percentile <p>",
		"top 1-p fraction of detection samples to brick-wall",
		parseLimitPercentile,
		DEFAULT_LIMIT_PERCENTILE,
	);
	command.option("--limit-db <dB>", "limit-anchor override in dB", parseNegativeDb("limit-db", -60));
	command.option("--smoothing <ms>", "envelope window in milliseconds", parseSmoothing, DEFAULT_SMOOTHING_MS);
	command.option("--never-expand", "keep the upper arm flat or compressive");
	command.option(
		"--tolerance <dB>",
		"landing tolerance in dB on the targeted figure",
		parseTolerance,
		DEFAULT_TOLERANCE,
	);
	command.action(async (input: string, options: TargetOptions) =>
		target(input, { ...options, scratchDir: scratchDirectoryOf(command) }),
	);
};
