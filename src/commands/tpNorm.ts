import { InvalidArgumentError, type Command } from "commander";
import { dbToLinear, linearToDb } from "../utils/db";
import { applyUniformGain } from "./utils/applyUniformGain";
import { measureTruePeak } from "./utils/measureTruePeak";

interface TpNormOptions {
	readonly output: string;
	readonly target?: number;
}

const LABEL_WIDTH = 16;

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const parseTargetDb = (value: string): number => {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || parsed >= 0) {
		throw new InvalidArgumentError(`target must be < 0, received ${value}`);
	}

	return parsed;
};

export const tpNorm = async (inputPath: string, options: TpNormOptions): Promise<void> => {
	const target = options.target ?? -1;
	const measurement = await measureTruePeak(inputPath);
	const gain = measurement.truePeak <= 0 ? 1 : dbToLinear(target - linearToDb(measurement.truePeak));

	await applyUniformGain(inputPath, options.output, gain);

	const sourceTpDb = linearToDb(measurement.truePeak);
	const gainDb = linearToDb(gain);

	process.stdout.write(
		`${[
			alignedLine("source true peak", `${sourceTpDb.toFixed(2)} dBTP`),
			alignedLine("target", `${target.toFixed(2)} dBTP`),
			alignedLine("applied gain", `${gainDb.toFixed(2)} dB`),
			alignedLine("output", options.output),
		].join("\n")}\n`,
	);
};

export const addTpNormCommand = (program: Command): void => {
	program
		.command("tp-norm")
		.description("Normalize a WAV file to a true-peak target")
		.argument("<input>", "input WAV path")
		.requiredOption("-o, --output <path>", "output WAV path")
		.option("--target <dBTP>", "target true peak in dBTP", parseTargetDb, -1)
		.action(tpNorm);
};
