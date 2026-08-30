import { InvalidArgumentError, type Command } from "commander";
import { IntegratedLufsAccumulator } from "../measurement/IntegratedLufsAccumulator";
import { TruePeakAccumulator } from "../measurement/TruePeakAccumulator";
import { dbToLinear } from "../utils/db";
import { isMultipleOf } from "../utils/multipleOf";
import { applyUniformGain } from "./utils/applyUniformGain";
import { copyUnchanged } from "./utils/copyUnchanged";
import { pushWavBlocks, withWavReader } from "./utils/withWavReader";

interface LufsNormOptions {
	readonly output: string;
	readonly lufs?: number;
}

const LABEL_WIDTH = 18;
const DEFAULT_TARGET_LUFS = -16;

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const TARGET_LUFS_STEP = 0.1;

const isTargetLufsInRange = (target: number): boolean =>
	Number.isFinite(target) && target >= -50 && target <= 0 && isMultipleOf(target, TARGET_LUFS_STEP);

const assertTargetLufs = (target: number, received: string | number): void => {
	if (!isTargetLufsInRange(target)) {
		throw new InvalidArgumentError(`lufs must be in [-50, 0] in steps of ${TARGET_LUFS_STEP}, received ${received}`);
	}
};

const parseTargetLufs = (value: string): number => {
	const parsed = Number(value);

	assertTargetLufs(parsed, value);

	return parsed;
};

const measureIntegratedAndTruePeak = async (
	path: string,
): Promise<{ readonly integratedLufs: number; readonly truePeak: number }> =>
	withWavReader(path, async (reader) => {
		const { sampleRate, channelCount } = reader.format;

		if (channelCount > 2) {
			throw new Error(
				`${path}: ${channelCount} channels unsupported; loudness measurement beyond stereo needs BS.1770 Table 3 channel weighting`,
			);
		}

		const lufsAccumulator = new IntegratedLufsAccumulator(sampleRate, channelCount);
		const truePeakAccumulator = new TruePeakAccumulator(channelCount);

		await pushWavBlocks(reader, [lufsAccumulator, truePeakAccumulator]);

		return {
			integratedLufs: lufsAccumulator.finalize(),
			truePeak: truePeakAccumulator.finalize(),
		};
	});

export const lufsNorm = async (inputPath: string, options: LufsNormOptions): Promise<void> => {
	const target = options.lufs ?? DEFAULT_TARGET_LUFS;

	assertTargetLufs(target, target);

	const measurement = await measureIntegratedAndTruePeak(inputPath);

	if (!Number.isFinite(measurement.integratedLufs)) {
		await copyUnchanged(inputPath, options.output);
		process.stderr.write("source has no measurable loudness; passed through unchanged\n");

		return;
	}

	const gainDb = target - measurement.integratedLufs;
	const gain = dbToLinear(gainDb);
	const sourceTpDb = 20 * Math.log10(measurement.truePeak);
	const outputTruePeakDb = sourceTpDb + gainDb;

	await applyUniformGain(inputPath, options.output, gain);

	if (outputTruePeakDb > 0) {
		process.stderr.write(`warning: predicted output true peak ${outputTruePeakDb.toFixed(2)} dBTP exceeds 0 dBTP\n`);
	}

	process.stdout.write(
		`${[
			alignedLine("source integrated", `${measurement.integratedLufs.toFixed(2)} LUFS`),
			alignedLine("target", `${target.toFixed(2)} LUFS`),
			alignedLine("applied gain", `${gainDb.toFixed(2)} dB`),
			alignedLine("output true peak", `${outputTruePeakDb.toFixed(2)} dBTP`),
			alignedLine("output", options.output),
		].join("\n")}\n`,
	);
};

export const addLufsNormCommand = (program: Command): void => {
	const command = program.command("lufs-norm");

	command.description("Normalize a WAV file to an integrated-loudness target");
	command.argument("<input>", "input WAV path");
	command.requiredOption("-o, --output <path>", "output WAV path");
	command.option("--lufs <LUFS>", "target integrated loudness in LUFS", parseTargetLufs, DEFAULT_TARGET_LUFS);
	command.action(lufsNorm);
};
