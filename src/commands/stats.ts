import { channelWeightsOf } from "../measurement/channelWeights";
import { IntegratedLufsAccumulator } from "../measurement/IntegratedLufsAccumulator";
import { computeLoudnessRange } from "../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../measurement/ShortTermLoudnessAccumulator";
import { TruePeakAccumulator } from "../measurement/TruePeakAccumulator";
import { linearToDb } from "../utils/db";
import { withAudioInput } from "./utils/AudioInput";
import { STDIO_PATH } from "./utils/stdioPath";
import { pushWavBlocks } from "./utils/withWavReader";
import type { SourceBitDepth } from "../wav/utils/wavFormat";
import type { Command } from "commander";

interface StatsJson {
	readonly path: string;
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly bitDepth: SourceBitDepth;
	readonly durationSeconds: number;
	readonly truePeakDb: number | null;
	readonly integratedLufs: number | null;
	readonly loudnessRange: number | null;
}

interface StatsOptions {
	readonly json?: boolean;
}

const LABEL_WIDTH = 14;

const alignedLine = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)}    ${value}`;

const formatHuman = (result: StatsJson): string => {
	const truePeak = result.truePeakDb === null ? "n/a" : `${result.truePeakDb.toFixed(2)} dBTP`;
	const integrated = result.integratedLufs === null ? "n/a" : `${result.integratedLufs.toFixed(2)} LUFS`;
	const loudnessRange = result.loudnessRange === null ? "n/a" : `${result.loudnessRange.toFixed(2)} LU`;

	return `${[
		result.path,
		alignedLine("sample rate", `${result.sampleRate} Hz`),
		alignedLine("channels", String(result.channelCount)),
		alignedLine("bit depth", result.bitDepth),
		alignedLine("duration", `${result.durationSeconds.toFixed(3)} s`),
		alignedLine("true peak", truePeak),
		alignedLine("integrated", integrated),
		alignedLine("loudness range", loudnessRange),
	].join("\n")}\n`;
};

const errorMessageOf = (error: unknown, inputPath: string): string => {
	const message = error instanceof Error ? error.message : String(error);

	const namesInput = message.includes(`"${inputPath}"`) || message.includes(`'${inputPath}'`);

	return namesInput ? message : `Cannot read "${inputPath}": ${message}`;
};

const measureStats = async (inputPath: string): Promise<StatsJson> =>
	withAudioInput(inputPath, { replayable: false, scratchDirectory: undefined }, async (input) =>
		input.withFirstPass(async (source) => {
			const { sampleRate, channelCount, channelMask, bitDepth } = source.format;
			const weights = channelWeightsOf(channelCount, channelMask);
			const truePeakAccumulator = new TruePeakAccumulator(channelCount);
			const lufsAccumulator = new IntegratedLufsAccumulator(sampleRate, weights);
			const shortTermAccumulator = new ShortTermLoudnessAccumulator(sampleRate, weights);

			const frameCount = await pushWavBlocks(source, [truePeakAccumulator, lufsAccumulator, shortTermAccumulator]);

			const truePeak = truePeakAccumulator.finalize();
			const integrated = lufsAccumulator.finalize();
			const shortTerm = shortTermAccumulator.finalize();

			return {
				path: inputPath,
				sampleRate,
				channelCount,
				bitDepth,
				durationSeconds: sampleRate === 0 ? 0 : frameCount / sampleRate,
				truePeakDb: frameCount === 0 ? null : linearToDb(truePeak),
				integratedLufs: Number.isFinite(integrated) ? integrated : null,
				loudnessRange: shortTerm.length === 0 ? null : computeLoudnessRange(shortTerm),
			};
		}),
	);

export const stats = async (inputs: Array<string>, options: StatsOptions): Promise<void> => {
	if (inputs.filter((inputPath) => inputPath === STDIO_PATH).length > 1) {
		throw new Error("stdin can be read once");
	}

	const results: Array<StatsJson> = [];
	let failed = false;

	for (const inputPath of inputs) {
		try {
			const result = await measureStats(inputPath);

			results.push(result);

			if (options.json !== true) {
				if (results.length > 1) {
					process.stdout.write("\n");
				}

				process.stdout.write(formatHuman(result));
			}
		} catch (error: unknown) {
			failed = true;
			process.stderr.write(`error: ${errorMessageOf(error, inputPath)}\n`);
		}
	}

	if (options.json === true) {
		process.stdout.write(`${JSON.stringify(results)}\n`);
	}

	if (failed) {
		process.exitCode = 1;
	}
};

export const addStatsCommand = (program: Command): void => {
	program
		.command("stats")
		.description("Report true-peak, integrated loudness, and loudness range of WAV files")
		.argument("<inputs...>", "input WAV paths, or - for stdin")
		.option("--json", "print JSON")
		.action(stats);
};
