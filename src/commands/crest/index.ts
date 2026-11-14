import { rm } from "node:fs/promises";
import { InvalidArgumentError, type Command } from "commander";
import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { figureText, peakDbOrNull } from "../../utils/db";
import { Scratch } from "../../utils/Scratch";
import { replayableInputOptionsOf, withAudioInput } from "../utils/AudioInput";
import { audioOptionsOf } from "../utils/AudioProgram";
import { writeSummary } from "../utils/sinks";
import { pushWavBlocks } from "../utils/withWavReader";
import { crestLayoutOf, stretchFramesOf } from "./utils/layout";
import { renderStage } from "./utils/renderStage";
import { solveStage } from "./utils/solveStage";
import { StretchPeakMeter } from "./utils/StretchPeakMeter";
import type { BlockSource } from "../../wav/WavReader";
import type { AudioOutput } from "../utils/sinks";
import type { StreamOptions } from "../utils/streamOptions";

interface CrestOptions {
	readonly output: string;
	readonly spread?: number;
	readonly steps?: number;
	readonly smoothing?: number;
	readonly scratchDir?: string;
	readonly inputStream?: StreamOptions;
	readonly outputStream?: StreamOptions;
}

const LABEL_WIDTH = 16;
const DEFAULT_SPREAD_MS = 8;
const DEFAULT_STEPS = 2;
const DEFAULT_SMOOTHING_MS = 100;
const MAX_SPREAD_MS = 50;
const MAX_STEPS = 8;

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const printedDbOf = (amplitude: number): number | null => {
	const db = peakDbOrNull(amplitude);

	return db === null ? null : Number(db.toFixed(2));
};

const parseSpread = (value: string): number => {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_SPREAD_MS) {
		throw new InvalidArgumentError(`spread must be in (0, ${MAX_SPREAD_MS}], received ${value}`);
	}

	return parsed;
};

const parseSteps = (value: string): number => {
	const parsed = Number(value);

	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_STEPS) {
		throw new InvalidArgumentError(`steps must be an integer in [1, ${MAX_STEPS}], received ${value}`);
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
	smoothingMs: number,
): Promise<{
	readonly sampleRate: number;
	readonly frameCount: number;
	readonly truePeak: number;
	readonly peaks: Float64Array;
}> => {
	const { sampleRate, channelCount } = source.format;
	const meter = new StretchPeakMeter({ stretchFrames: stretchFramesOf({ smoothingMs, sampleRate }), channelCount });
	const truePeakAccumulator = new TruePeakAccumulator(channelCount);
	const frameCount = await pushWavBlocks(source, [meter, truePeakAccumulator]);

	return { sampleRate, frameCount, truePeak: truePeakAccumulator.finalize(), peaks: meter.finish() };
};

const intermediateOutputOf = (path: string, channelMask: number): AudioOutput => ({
	sink: { kind: "file", path },
	container: "wav",
	bitDepth: "64f",
	channelMask,
});

export const crest = async (inputPath: string, options: CrestOptions): Promise<void> => {
	const settings = {
		spreadMs: options.spread ?? DEFAULT_SPREAD_MS,
		steps: options.steps ?? DEFAULT_STEPS,
		smoothingMs: options.smoothing ?? DEFAULT_SMOOTHING_MS,
	};

	await withAudioInput(inputPath, replayableInputOptionsOf(options), async (input) => {
		const measurement = await input.withFirstPass(async (source) => meterSource(source, settings.smoothingMs));
		const layout = crestLayoutOf({
			...settings,
			sampleRate: measurement.sampleRate,
			frameCount: measurement.frameCount,
		});

		if (measurement.peaks.length !== layout.stretchCount) {
			throw new Error(`crest metered ${measurement.peaks.length} stretches for a layout of ${layout.stretchCount}`);
		}

		const sourcePath = input.replayPath();
		const scratch = await Scratch.create(options.scratchDir);
		let currentPath = sourcePath;
		let peaks = measurement.peaks;
		let outputTruePeak: number | undefined;

		try {
			for (const [stepIndex] of layout.steps.entries()) {
				const isLast = stepIndex === layout.steps.length - 1;
				const solve = await solveStage({ sourcePath, currentPath, layout, stepIndex, peaks });
				const path = solve.path();

				if (!isLast && path.every((state) => state === 0)) {
					continue;
				}

				const stagePath = scratch.filePath(`stage-${stepIndex}.wav`);
				const rendered = await renderStage({
					sourcePath,
					currentPath,
					layout,
					stepIndex,
					path,
					output: isLast ? input.output() : intermediateOutputOf(stagePath, input.output().channelMask),
					isLast,
				});

				if (currentPath !== sourcePath) {
					await rm(currentPath, { force: true });
				}

				currentPath = stagePath;
				peaks = rendered.peaks;
				outputTruePeak = rendered.truePeak;
			}
		} finally {
			await scratch.dispose();
		}

		if (outputTruePeak === undefined) {
			throw new Error("crest metered no output true peak; its last stage did not render");
		}

		const sourceDb = printedDbOf(measurement.truePeak);
		const outputDb = printedDbOf(outputTruePeak);
		const deltaDb = sourceDb === null || outputDb === null ? null : outputDb - sourceDb;

		await writeSummary(
			options.output,
			`${[
				alignedLine("source true peak", figureText(sourceDb, 2, "dBTP")),
				alignedLine("output true peak", figureText(outputDb, 2, "dBTP")),
				alignedLine("delta", figureText(deltaDb, 2, "dB")),
				alignedLine("output", options.output),
			].join("\n")}\n`,
		);
	});
};

export const addCrestCommand = (program: Command): void => {
	const command = program.command("crest");

	command.description(
		"Lower true peak by blending peaks with copies whose phase is spread a few milliseconds earlier and later; loudness drops where it acts",
	);
	command.argument("<input>", "input path, WAV unless -f names a raw format, or - or pipe: for a pipe");
	command.requiredOption(
		"-o, --output <path>",
		"output path, WAV unless -f names a raw format, or - or pipe: for a pipe",
	);
	command.option("--spread <ms>", "widest spread in milliseconds", parseSpread, DEFAULT_SPREAD_MS);
	command.option(
		"--steps <n>",
		"number of spreads, each a quarter of the last, each used earlier and later",
		parseSteps,
		DEFAULT_STEPS,
	);
	command.option(
		"--smoothing <ms>",
		"milliseconds the blend takes to fade in or out",
		parseSmoothing,
		DEFAULT_SMOOTHING_MS,
	);
	command.action(async (input: string, options: CrestOptions) =>
		crest(input, { ...options, ...audioOptionsOf(command) }),
	);
};
