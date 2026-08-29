import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import { IntegratedLufsAccumulator } from "../measurement/IntegratedLufsAccumulator";
import { dbToLinear, linearToDb } from "../utils/db";
import { applyUniformGain } from "./utils/applyUniformGain";
import { pushWavBlocks, withWavReader } from "./utils/withWavReader";

interface LufsNormOptions {
	readonly output: string;
	readonly target?: number;
}

const LABEL_WIDTH = 18;
const DEFAULT_TARGET_LUFS = -16;

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const parseTargetLufs = (value: string): number => {
	const parsed = Number(value);

	if (!Number.isFinite(parsed)) {
		throw new InvalidArgumentError(`target must be finite, received ${value}`);
	}

	return parsed;
};

const measureIntegrated = async (path: string): Promise<number> =>
	withWavReader(path, async (reader) => {
		const accumulator = new IntegratedLufsAccumulator(reader.format.sampleRate, reader.format.channelCount);

		await pushWavBlocks(reader, [accumulator]);

		return accumulator.finalize();
	});

const copyUnchanged = async (inputPath: string, outputPath: string): Promise<void> => {
	if (resolve(inputPath) === resolve(outputPath)) {
		return;
	}

	await copyFile(inputPath, outputPath);
};

export const lufsNorm = async (inputPath: string, options: LufsNormOptions): Promise<void> => {
	const target = options.target ?? DEFAULT_TARGET_LUFS;
	const integrated = await measureIntegrated(inputPath);

	if (!Number.isFinite(integrated)) {
		await copyUnchanged(inputPath, options.output);
		process.stderr.write("source has no measurable loudness; passed through unchanged\n");

		return;
	}

	const gain = dbToLinear(target - integrated);

	await applyUniformGain(inputPath, options.output, gain);

	process.stdout.write(
		`${[
			alignedLine("source integrated", `${integrated.toFixed(2)} LUFS`),
			alignedLine("target", `${target.toFixed(2)} LUFS`),
			alignedLine("applied gain", `${linearToDb(gain).toFixed(2)} dB`),
			alignedLine("output", options.output),
		].join("\n")}\n`,
	);
};

export const addLufsNormCommand = (program: Command): void => {
	const command = program.command("lufs-norm");

	command.description("Normalize a WAV file to an integrated-loudness target");
	command.argument("<input>", "input WAV path");
	command.requiredOption("-o, --output <path>", "output WAV path");
	command.option("--target <LUFS>", "target integrated loudness in LUFS", parseTargetLufs, DEFAULT_TARGET_LUFS);
	command.action(lufsNorm);
};
