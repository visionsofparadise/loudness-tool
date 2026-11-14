import { InvalidArgumentError, type Command } from "commander";
import { channelWeightsOf } from "../measurement/channelWeights";
import { IntegratedLufsAccumulator } from "../measurement/IntegratedLufsAccumulator";
import { dbToLinear, figureText, peakDbOrNull } from "../utils/db";
import { isMultipleOf } from "../utils/multipleOf";
import { applyUniformGain } from "./utils/applyUniformGain";
import { replayableInputOptionsOf, withAudioInput } from "./utils/AudioInput";
import { audioOptionsOf } from "./utils/AudioProgram";
import { copyUnchanged } from "./utils/copyUnchanged";
import { writeSummary } from "./utils/sinks";
import { pushWavBlocks } from "./utils/withWavReader";
import type { StreamOptions } from "./utils/streamOptions";
import type { BlockSource } from "../wav/WavReader";

interface LufsNormOptions {
	readonly output: string;
	readonly lufs?: number;
	readonly scratchDir?: string;
	readonly inputStream?: StreamOptions;
	readonly outputStream?: StreamOptions;
}

const LABEL_WIDTH = 18;
const DEFAULT_TARGET_LUFS = -16;

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const TARGET_LUFS_STEP = 0.1;

const isTargetLufsInRange = (target: number): boolean =>
	Number.isFinite(target) && target >= -50 && target <= 0 && isMultipleOf(target, TARGET_LUFS_STEP);

const targetLufsMessage = (received: string | number): string =>
	`lufs must be in [-50, 0] in steps of ${TARGET_LUFS_STEP}, received ${received}`;

const parseTargetLufs = (value: string): number => {
	const parsed = Number(value);

	if (!isTargetLufsInRange(parsed)) {
		throw new InvalidArgumentError(targetLufsMessage(value));
	}

	return parsed;
};

const MAX_GAIN_UPDATES = 10;
const LANDING_TOLERANCE_LU = 0.01;

const measureIntegrated = async (source: BlockSource): Promise<IntegratedLufsAccumulator> => {
	const { sampleRate, channelCount, channelMask } = source.format;
	const accumulator = new IntegratedLufsAccumulator(sampleRate, channelWeightsOf(channelCount, channelMask));

	await pushWavBlocks(source, [accumulator]);

	return accumulator;
};

const gainDbFor = (accumulator: IntegratedLufsAccumulator, target: number): number => {
	let gainDb = target - accumulator.finalize();
	let bestGainDb = gainDb;
	let bestDistance = Number.POSITIVE_INFINITY;

	for (let update = 0; update <= MAX_GAIN_UPDATES; update++) {
		const error = target - accumulator.integratedAtGain(gainDb);

		if (!Number.isFinite(error)) {
			break;
		}

		if (Math.abs(error) < bestDistance) {
			bestGainDb = gainDb;
			bestDistance = Math.abs(error);
		}

		if (bestDistance <= LANDING_TOLERANCE_LU) {
			break;
		}

		gainDb += error;
	}

	return bestGainDb;
};

export const lufsNorm = async (inputPath: string, options: LufsNormOptions): Promise<void> => {
	const target = options.lufs ?? DEFAULT_TARGET_LUFS;

	if (!isTargetLufsInRange(target)) {
		throw new Error(targetLufsMessage(target));
	}

	await withAudioInput(inputPath, replayableInputOptionsOf(options), async (input) => {
		const accumulator = await input.withFirstPass(measureIntegrated);
		const sourceLufs = accumulator.finalize();

		if (!Number.isFinite(sourceLufs)) {
			await copyUnchanged(input.replayPath(), input.output());
			process.stderr.write("source has no measurable loudness; passed through unchanged\n");

			return;
		}

		const gainDb = gainDbFor(accumulator, target);
		const { truePeak } = await applyUniformGain(input.replayPath(), input.output(), dbToLinear(gainDb));
		const outputTruePeakDb = peakDbOrNull(truePeak);

		if (outputTruePeakDb !== null && outputTruePeakDb > 0) {
			process.stderr.write(`warning: output true peak ${outputTruePeakDb.toFixed(2)} dBTP exceeds 0 dBTP\n`);
		}

		await writeSummary(
			options.output,
			`${[
				alignedLine("source integrated", `${sourceLufs.toFixed(2)} LUFS`),
				alignedLine("target", `${target.toFixed(2)} LUFS`),
				alignedLine("applied gain", `${gainDb.toFixed(2)} dB`),
				alignedLine("output true peak", figureText(outputTruePeakDb, 2, "dBTP")),
				alignedLine("output", options.output),
			].join("\n")}\n`,
		);
	});
};

export const addLufsNormCommand = (program: Command): void => {
	const command = program.command("lufs-norm");

	command.description("Normalize audio to an integrated-loudness target");
	command.argument("<input>", "input path, WAV unless -f names a raw format, or - or pipe: for a pipe");
	command.requiredOption(
		"-o, --output <path>",
		"output path, WAV unless -f names a raw format, or - or pipe: for a pipe",
	);
	command.option("--lufs <LUFS>", "target integrated loudness in LUFS", parseTargetLufs, DEFAULT_TARGET_LUFS);
	command.action(async (input: string, options: LufsNormOptions) =>
		lufsNorm(input, { ...options, ...audioOptionsOf(command) }),
	);
};
