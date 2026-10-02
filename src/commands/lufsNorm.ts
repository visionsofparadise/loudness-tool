import { InvalidArgumentError, type Command } from "commander";
import { channelWeightsOf } from "../measurement/channelWeights";
import { IntegratedLufsAccumulator } from "../measurement/IntegratedLufsAccumulator";
import { TruePeakAccumulator } from "../measurement/TruePeakAccumulator";
import { dbToLinear } from "../utils/db";
import { isMultipleOf } from "../utils/multipleOf";
import { applyUniformGain } from "./utils/applyUniformGain";
import { scratchDirectoryOf, withAudioInput } from "./utils/AudioInput";
import { copyUnchanged } from "./utils/copyUnchanged";
import { sinkOf, summaryStreamOf } from "./utils/sinks";
import { pushWavBlocks } from "./utils/withWavReader";
import type { BlockSource } from "../wav/WavReader";

interface LufsNormOptions {
	readonly output: string;
	readonly lufs?: number;
	readonly scratchDir?: string;
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
	source: BlockSource,
): Promise<{ readonly integratedLufs: number; readonly truePeak: number }> => {
	const { sampleRate, channelCount, channelMask } = source.format;
	const lufsAccumulator = new IntegratedLufsAccumulator(sampleRate, channelWeightsOf(channelCount, channelMask));
	const truePeakAccumulator = new TruePeakAccumulator(channelCount);

	await pushWavBlocks(source, [lufsAccumulator, truePeakAccumulator]);

	return {
		integratedLufs: lufsAccumulator.finalize(),
		truePeak: truePeakAccumulator.finalize(),
	};
};

export const lufsNorm = async (inputPath: string, options: LufsNormOptions): Promise<void> => {
	const target = options.lufs ?? DEFAULT_TARGET_LUFS;

	assertTargetLufs(target, target);

	await withAudioInput(inputPath, { replayable: true, scratchDirectory: options.scratchDir }, async (input) => {
		const measurement = await input.withFirstPass(measureIntegratedAndTruePeak);
		const sink = sinkOf(options.output);

		if (!Number.isFinite(measurement.integratedLufs)) {
			await copyUnchanged(input.replayPath(), sink);
			process.stderr.write("source has no measurable loudness; passed through unchanged\n");

			return;
		}

		const gainDb = target - measurement.integratedLufs;
		const gain = dbToLinear(gainDb);
		const sourceTpDb = 20 * Math.log10(measurement.truePeak);
		const outputTruePeakDb = sourceTpDb + gainDb;

		await applyUniformGain(input.replayPath(), sink, gain);

		if (outputTruePeakDb > 0) {
			process.stderr.write(
				`warning: predicted output true peak ${outputTruePeakDb.toFixed(2)} dBTP exceeds 0 dBTP\n`,
			);
		}

		summaryStreamOf(options.output).write(
			`${[
				alignedLine("source integrated", `${measurement.integratedLufs.toFixed(2)} LUFS`),
				alignedLine("target", `${target.toFixed(2)} LUFS`),
				alignedLine("applied gain", `${gainDb.toFixed(2)} dB`),
				alignedLine("output true peak", `${outputTruePeakDb.toFixed(2)} dBTP`),
				alignedLine("output", options.output),
			].join("\n")}\n`,
		);
	});
};

export const addLufsNormCommand = (program: Command): void => {
	const command = program.command("lufs-norm");

	command.description("Normalize a WAV file to an integrated-loudness target");
	command.argument("<input>", "input WAV path, or - for stdin");
	command.requiredOption("-o, --output <path>", "output WAV path, or - for stdout");
	command.option("--lufs <LUFS>", "target integrated loudness in LUFS", parseTargetLufs, DEFAULT_TARGET_LUFS);
	command.action(async (input: string, options: LufsNormOptions) =>
		lufsNorm(input, { ...options, scratchDir: scratchDirectoryOf(command) }),
	);
};
