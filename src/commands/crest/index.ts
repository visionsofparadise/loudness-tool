import { InvalidArgumentError, type Command } from "commander";
import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { linearToDb } from "../../utils/db";
import { copyUnchanged } from "../utils/copyUnchanged";
import { pushWavBlocks, withWavReader } from "../utils/withWavReader";
import { withWavWriter } from "../utils/withWavWriter";
import { LATTICE_ORDER } from "./utils/lattice";
import { LatticeApplyState } from "./utils/LatticeApplyState";
import { isPowerOfTwo } from "./utils/powerOfTwo";
import { groupDelayLambda } from "./utils/search";
import {
	hopSizeOf,
	stftFrameCount,
	streamLatticeTrajectory,
	type ItemSevenSearchParams,
	type LatticeAnalysisSource,
} from "./utils/stft";
import { exactHoldHalfWidthFrames, smoothControlTrajectory, trajectoryFrameRate } from "./utils/trajectory";
import { TruePeakArgmaxAccumulator } from "./utils/TruePeakArgmaxAccumulator";
import type { WavReader } from "../../wav/WavReader";

interface CrestOptions {
	readonly output: string;
	readonly smoothing?: number;
	readonly frameSize?: number;
}

const LABEL_WIDTH = 16;
const DEFAULT_SMOOTHING_MS = 100;
const DEFAULT_FRAME_SIZE = 2048;

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const parseSmoothing = (value: string): number => {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new InvalidArgumentError(`smoothing must be >= 0, received ${value}`);
	}

	return parsed;
};

const parseFrameSize = (value: string): number => {
	const parsed = Number(value);

	if (!isPowerOfTwo(parsed) || parsed < 4) {
		throw new InvalidArgumentError(`frame-size must be a power of two >= 4, received ${value}`);
	}

	return parsed;
};

const analysisSourceOf = (reader: WavReader): LatticeAnalysisSource => ({
	channelCount: reader.format.channelCount,
	signalLength: reader.format.frameCount,
	async *blocks() {
		for await (const block of reader.blocks()) {
			yield block.channels;
		}
	},
});

const printReport = (sourceTruePeakDb: number, outputTruePeakDb: number, outputPath: string): void => {
	const delta = outputTruePeakDb - sourceTruePeakDb;

	process.stdout.write(
		`${[
			alignedLine("source true peak", `${sourceTruePeakDb.toFixed(2)} dBTP`),
			alignedLine("output true peak", `${outputTruePeakDb.toFixed(2)} dBTP`),
			alignedLine("delta", `${delta.toFixed(2)} dB`),
			alignedLine("output", outputPath),
		].join("\n")}\n`,
	);
};

const measureSourcePeak = async (
	inputPath: string,
): Promise<{
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly frameCount: number;
	readonly truePeakDb: number;
	readonly peakInputSample: number;
}> =>
	withWavReader(inputPath, async (reader) => {
		const { sampleRate, channelCount, frameCount } = reader.format;

		if (channelCount <= 0) {
			return { sampleRate, channelCount, frameCount, truePeakDb: linearToDb(0), peakInputSample: 0 };
		}

		const argmax = new TruePeakArgmaxAccumulator(channelCount);
		const truePeak = new TruePeakAccumulator(channelCount);

		await pushWavBlocks(reader, [argmax, truePeak]);

		return {
			sampleRate,
			channelCount,
			frameCount,
			truePeakDb: linearToDb(truePeak.finalize()),
			peakInputSample: argmax.finalize().peakInputSample,
		};
	});

export const crest = async (inputPath: string, options: CrestOptions): Promise<void> => {
	const smoothingMs = options.smoothing ?? DEFAULT_SMOOTHING_MS;
	const frameSize = options.frameSize ?? DEFAULT_FRAME_SIZE;

	if (!isPowerOfTwo(frameSize) || frameSize < 4) {
		throw new InvalidArgumentError(`frame-size must be a power of two >= 4, received ${frameSize}`);
	}

	const hopSize = hopSizeOf(frameSize);
	const source = await measureSourcePeak(inputPath);

	if (source.channelCount === 0 || stftFrameCount(source.frameCount, frameSize, hopSize) === 0) {
		await copyUnchanged(inputPath, options.output);
		printReport(source.truePeakDb, source.truePeakDb, options.output);

		return;
	}

	const search: ItemSevenSearchParams = {
		globalTruePeakDb: source.truePeakDb,
		peakInputSample: source.peakInputSample,
		sampleRate: source.sampleRate,
		lambda: groupDelayLambda(source.sampleRate, LATTICE_ORDER),
	};

	const { trajectory, frameCount } = await withWavReader(inputPath, async (reader) =>
		streamLatticeTrajectory(analysisSourceOf(reader), frameSize, hopSize, search),
	);

	if (frameCount === 0) {
		await copyUnchanged(inputPath, options.output);
		printReport(source.truePeakDb, source.truePeakDb, options.output);

		return;
	}

	const smoothed = smoothControlTrajectory(
		trajectory,
		smoothingMs,
		trajectoryFrameRate(source.sampleRate, hopSize),
		exactHoldHalfWidthFrames(source.sampleRate, hopSize),
		hopSize,
	);

	let outputTruePeakDb = source.truePeakDb;

	await withWavWriter(inputPath, options.output, async (reader, writer) => {
		const applyState = new LatticeApplyState(smoothed, LATTICE_ORDER, hopSize, source.channelCount);
		const outputPeak = new TruePeakAccumulator(source.channelCount);

		for await (const block of reader.blocks()) {
			const blockFrames = block.channels[0]?.length ?? 0;

			applyState.apply(block.channels, blockFrames);
			outputPeak.push(block.channels, blockFrames);
			await writer.write(block.channels);
		}

		outputTruePeakDb = linearToDb(outputPeak.finalize());
	});

	printReport(source.truePeakDb, outputTruePeakDb, options.output);
};

export const addCrestCommand = (program: Command): void => {
	const command = program.command("crest");

	command.description("Reduce crest factor by rearranging phase");
	command.argument("<input>", "input WAV path");
	command.requiredOption("-o, --output <path>", "output WAV path");
	command.option(
		"--smoothing <ms>",
		"bidirectional control-trajectory time constant in milliseconds",
		parseSmoothing,
		DEFAULT_SMOOTHING_MS,
	);
	command.option("--frame-size <n>", "analysis frame length in samples", parseFrameSize, DEFAULT_FRAME_SIZE);
	command.action(crest);
};
