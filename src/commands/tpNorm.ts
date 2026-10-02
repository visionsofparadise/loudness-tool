import { InvalidArgumentError, type Command } from "commander";
import { dbToLinear } from "../utils/db";
import { applyUniformGain } from "./utils/applyUniformGain";
import { scratchDirectoryOf, withAudioInput } from "./utils/AudioInput";
import { copyUnchanged } from "./utils/copyUnchanged";
import { measureTruePeak } from "./utils/measureTruePeak";
import { sinkOf, summaryStreamOf } from "./utils/sinks";

interface TpNormOptions {
	readonly output: string;
	readonly tp?: number;
	readonly scratchDir?: string;
}

const LABEL_WIDTH = 16;
const DEFAULT_TARGET_DB = -1;

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const isTargetDbInRange = (target: number): boolean => Number.isFinite(target) && target >= -24 && target < 0;

const assertTargetDb = (target: number, received: string | number): void => {
	if (!isTargetDbInRange(target)) {
		throw new InvalidArgumentError(`tp must be in [-24, 0), received ${received}`);
	}
};

const parseTargetDb = (value: string): number => {
	const parsed = Number(value);

	assertTargetDb(parsed, value);

	return parsed;
};

export const tpNorm = async (inputPath: string, options: TpNormOptions): Promise<void> => {
	const target = options.tp ?? DEFAULT_TARGET_DB;

	assertTargetDb(target, target);

	await withAudioInput(inputPath, { replayable: true, scratchDirectory: options.scratchDir }, async (input) => {
		const measurement = await input.withFirstPass(measureTruePeak);
		const sink = sinkOf(options.output);

		if (measurement.truePeak <= 0) {
			await copyUnchanged(input.replayPath(), sink);
			process.stderr.write("source has no measurable true peak; passed through unchanged\n");

			return;
		}

		const gain = dbToLinear(target) / measurement.truePeak;

		await applyUniformGain(input.replayPath(), sink, gain);

		const sourceTpDb = 20 * Math.log10(measurement.truePeak);
		const gainDb = 20 * Math.log10(gain);

		summaryStreamOf(options.output).write(
			`${[
				alignedLine("source true peak", `${sourceTpDb.toFixed(2)} dBTP`),
				alignedLine("target", `${target.toFixed(2)} dBTP`),
				alignedLine("applied gain", `${gainDb.toFixed(2)} dB`),
				alignedLine("output", options.output),
			].join("\n")}\n`,
		);
	});
};

export const addTpNormCommand = (program: Command): void => {
	program
		.command("tp-norm")
		.description("Normalize a WAV file to a true-peak target")
		.argument("<input>", "input WAV path, or - for stdin")
		.requiredOption("-o, --output <path>", "output WAV path, or - for stdout")
		.option("--tp <dBTP>", "target true peak in dBTP", parseTargetDb, DEFAULT_TARGET_DB)
		.action(async (input: string, options: TpNormOptions, command: Command) =>
			tpNorm(input, { ...options, scratchDir: scratchDirectoryOf(command) }),
		);
};
