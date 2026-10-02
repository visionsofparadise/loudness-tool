import { InvalidArgumentError, type Command } from "commander";
import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { nearestWritableBitDepth, type WavBitDepth } from "../../wav/utils/wavFormat";
import { scratchDirectoryOf, withAudioInput } from "../utils/AudioInput";
import { sinkOf, writeSummary } from "../utils/sinks";
import { pushWavBlocks } from "../utils/withWavReader";
import { applyWalk } from "./utils/apply";
import { crestLayoutOf, stretchFramesOf } from "./utils/ladder";
import { printedDbOf } from "./utils/rounding";
import { solveCrest } from "./utils/solve";
import { SourceMeter } from "./utils/SourceMeter";
import type { BlockSource } from "../../wav/WavReader";

interface CrestOptions {
	readonly output: string;
	readonly spread?: number;
	readonly smoothing?: number;
	readonly scratchDir?: string;
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

const meterSource = async (
	source: BlockSource,
	ladder: { spreadMs: number; smoothingMs: number },
): Promise<{
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly bitDepth: WavBitDepth;
	readonly frameCount: number;
	readonly truePeak: number;
	readonly readings: Float64Array;
}> => {
	const { sampleRate, channelCount } = source.format;
	const bitDepth = nearestWritableBitDepth(source.format.bitDepth);
	const meter = new SourceMeter({
		stretchFrames: stretchFramesOf({ ...ladder, sampleRate }),
		channelCount,
		bitDepth,
	});
	const truePeakAccumulator = new TruePeakAccumulator(channelCount);
	const frameCount = await pushWavBlocks(source, [meter, truePeakAccumulator]);

	return {
		sampleRate,
		channelCount,
		bitDepth,
		frameCount,
		truePeak: truePeakAccumulator.finalize(),
		readings: meter.finish(),
	};
};

export const crest = async (inputPath: string, options: CrestOptions): Promise<void> => {
	const ladder = {
		spreadMs: options.spread ?? DEFAULT_SPREAD_MS,
		smoothingMs: options.smoothing ?? DEFAULT_SMOOTHING_MS,
	};

	await withAudioInput(inputPath, { replayable: true, scratchDirectory: options.scratchDir }, async (input) => {
		const measurement = await input.withFirstPass(async (source) => meterSource(source, ladder));
		const { sampleRate, channelCount, bitDepth, readings } = measurement;
		const layout = crestLayoutOf({ ...ladder, sampleRate, frameCount: measurement.frameCount });

		if (readings.length !== layout.stretchCount) {
			throw new Error(`crest metered ${readings.length} stretches for a layout of ${layout.stretchCount}`);
		}

		const replayPath = input.replayPath();
		const solution = await solveCrest({
			inputPath: replayPath,
			layout,
			bitDepth,
			channelCount,
			readings,
		});
		const outputTruePeak = await applyWalk({
			inputPath: replayPath,
			sink: sinkOf(options.output),
			layout,
			bitDepth,
			channelCount,
			walk: solution.walk,
		});
		const sourceDb = printedDbOf(measurement.truePeak);
		const outputDb = printedDbOf(outputTruePeak);

		await writeSummary(
			options.output,
			`${[
				alignedLine("source true peak", `${sourceDb.toFixed(2)} dBTP`),
				alignedLine("output true peak", `${outputDb.toFixed(2)} dBTP`),
				alignedLine("delta", `${(outputDb - sourceDb).toFixed(2)} dB`),
				alignedLine("output", options.output),
			].join("\n")}\n`,
		);
	});
};

export const addCrestCommand = (program: Command): void => {
	const command = program.command("crest");

	command.description("Lower the true peak of a WAV file by dispersing phase");
	command.argument("<input>", "input WAV path, or - for stdin");
	command.requiredOption("-o, --output <path>", "output WAV path, or - for stdout");
	command.option("--spread <ms>", "furthest energy is moved in milliseconds", parseSpread, DEFAULT_SPREAD_MS);
	command.option(
		"--smoothing <ms>",
		"milliseconds the spread takes to go from nothing to full",
		parseSmoothing,
		DEFAULT_SMOOTHING_MS,
	);
	command.action(async (input: string, options: CrestOptions) =>
		crest(input, { ...options, scratchDir: scratchDirectoryOf(command) }),
	);
};
