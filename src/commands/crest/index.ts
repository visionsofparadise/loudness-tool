import { InvalidArgumentError, type Command } from "commander";
import { nearestWritableBitDepth } from "../../wav/utils/wavFormat";
import { measureTruePeak } from "../utils/measureTruePeak";
import { applyWalk } from "./utils/apply";
import { crestLayoutOf } from "./utils/ladder";
import { printedDbOf } from "./utils/rounding";
import { solveCrest } from "./utils/solve";

interface CrestOptions {
	readonly output: string;
	readonly spread?: number;
	readonly smoothing?: number;
}

const LABEL_WIDTH = 16;
const DEFAULT_SPREAD_MS = 4;
const DEFAULT_SMOOTHING_MS = 100;
const MAX_SPREAD_MS = 50;

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const parseSpread = (value: string): number => {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_SPREAD_MS) {
		throw new InvalidArgumentError(`spread must be in (0, ${MAX_SPREAD_MS}], received ${value}`);
	}

	return parsed;
};

const parseSmoothing = (value: string): number => {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new InvalidArgumentError(`smoothing must be > 0, received ${value}`);
	}

	return parsed;
};

export const crest = async (inputPath: string, options: CrestOptions): Promise<void> => {
	const measurement = await measureTruePeak(inputPath);
	const bitDepth = nearestWritableBitDepth(measurement.bitDepth);
	const layout = crestLayoutOf({
		spreadMs: options.spread ?? DEFAULT_SPREAD_MS,
		smoothingMs: options.smoothing ?? DEFAULT_SMOOTHING_MS,
		sampleRate: measurement.sampleRate,
		frameCount: measurement.frameCount,
	});
	const solution = await solveCrest({
		inputPath,
		layout,
		bitDepth,
		channelCount: measurement.channelCount,
	});
	const outputTruePeak = await applyWalk({
		inputPath,
		outputPath: options.output,
		layout,
		bitDepth,
		channelCount: measurement.channelCount,
		walk: solution.walk,
	});
	const sourceDb = printedDbOf(measurement.truePeak);
	const outputDb = printedDbOf(outputTruePeak);

	process.stdout.write(
		`${[
			alignedLine("source true peak", `${sourceDb.toFixed(2)} dBTP`),
			alignedLine("output true peak", `${outputDb.toFixed(2)} dBTP`),
			alignedLine("delta", `${(outputDb - sourceDb).toFixed(2)} dB`),
			alignedLine("output", options.output),
		].join("\n")}\n`,
	);
};

export const addCrestCommand = (program: Command): void => {
	const command = program.command("crest");

	command.description("Lower the true peak of a WAV file by dispersing phase");
	command.argument("<input>", "input WAV path");
	command.requiredOption("-o, --output <path>", "output WAV path");
	command.option("--spread <ms>", "furthest energy is moved in milliseconds", parseSpread, DEFAULT_SPREAD_MS);
	command.option(
		"--smoothing <ms>",
		"milliseconds the spread takes to go from nothing to full",
		parseSmoothing,
		DEFAULT_SMOOTHING_MS,
	);
	command.action(crest);
};
