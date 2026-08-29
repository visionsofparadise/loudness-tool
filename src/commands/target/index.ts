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

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const parseFinite = (name: string, value: string, isValid: (parsed: number) => boolean, message: string): number => {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || !isValid(parsed)) {
		throw new InvalidArgumentError(`${name} ${message}, received ${value}`);
	}

	return parsed;
};

const parseLufs = (value: string): number =>
	parseFinite("lufs", value, (parsed) => parsed >= -50 && parsed <= 0, "must be in [-50, 0]");

const parseNegativeDb =
	(name: string) =>
	(value: string): number =>
		parseFinite(name, value, (parsed) => parsed < 0, "must be < 0");

const parseLimitPercentile = (value: string): number =>
	parseFinite("limit-percentile", value, (parsed) => parsed >= 0.5 && parsed <= 1, "must be in [0.5, 1.0]");

const parseSmoothing = (value: string): number =>
	parseFinite("smoothing", value, (parsed) => parsed >= 0.01 && parsed <= 200, "must be in [0.01, 200]");

const parseTolerance = (value: string): number =>
	parseFinite("tolerance", value, (parsed) => parsed > 0, "must be > 0");

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
		return reader.format.sampleRate;
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

	if (options.floor !== undefined && options.pivot !== undefined && options.floor >= options.pivot) {
		throw new InvalidArgumentError("floor must be < pivot when both are supplied");
	}

	const scratch = await Scratch.create(options.scratchDir);
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

			return;
		}

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
	} finally {
		await winningEnvelope?.close();
		await scratch.dispose();
	}
};

export const addTargetCommand = (program: Command): void => {
	const command = program.command("target");

	command.description("Fit a WAV file to a joint integrated-loudness and true-peak target");
	command.argument("<input>", "input WAV path");
	command.requiredOption("-o, --output <path>", "output WAV path");
	command.option("--lufs <n>", "target integrated loudness in LUFS", parseLufs, DEFAULT_TARGET_LUFS);
	command.option("--tp <dBTP>", "target true peak in dBTP", parseNegativeDb("tp"));
	command.option("--pivot <dB>", "body-anchor level in dB", parseNegativeDb("pivot"));
	command.option("--floor <dB>", "noise-gate level in dB", parseNegativeDb("floor"));
	command.option(
		"--limit-percentile <p>",
		"top 1-p fraction of detection samples to brick-wall",
		parseLimitPercentile,
		DEFAULT_LIMIT_PERCENTILE,
	);
	command.option("--limit-db <dB>", "limit-anchor override in dB", parseNegativeDb("limit-db"));
	command.option("--smoothing <ms>", "envelope time constant in milliseconds", parseSmoothing, DEFAULT_SMOOTHING_MS);
	command.option("--never-expand", "keep the upper arm flat or compressive");
	command.option("--tolerance <dB>", "LUFS exit threshold in dB", parseTolerance, DEFAULT_TOLERANCE);
	command.option("--scratch-dir <path>", "directory for temporary sample files");
	command.action(target);
};
