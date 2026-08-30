import { IntegratedLufsAccumulator } from "../measurement/IntegratedLufsAccumulator";
import { computeLoudnessRange } from "../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../measurement/ShortTermLoudnessAccumulator";
import { TruePeakAccumulator } from "../measurement/TruePeakAccumulator";
import { pushWavBlocks, withWavReader } from "./utils/withWavReader";
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

	return message.includes(inputPath) ? message : `Cannot read "${inputPath}": ${message}`;
};

const measureStats = async (inputPath: string): Promise<StatsJson> =>
	withWavReader(inputPath, async (reader) => {
		const { sampleRate, channelCount, bitDepth, frameCount } = reader.format;

		if (channelCount > 2) {
			throw new Error(
				`${inputPath}: ${channelCount} channels unsupported; loudness measurement beyond stereo needs BS.1770 Table 3 channel weighting`,
			);
		}

		const truePeakAccumulator = new TruePeakAccumulator(channelCount);
		const lufsAccumulator = new IntegratedLufsAccumulator(sampleRate, channelCount);
		const shortTermAccumulator = new ShortTermLoudnessAccumulator(sampleRate, channelCount);

		await pushWavBlocks(reader, [truePeakAccumulator, lufsAccumulator, shortTermAccumulator]);

		const truePeak = truePeakAccumulator.finalize();
		const integrated = lufsAccumulator.finalize();
		const shortTerm = shortTermAccumulator.finalize();

		return {
			path: inputPath,
			sampleRate,
			channelCount,
			bitDepth,
			durationSeconds: sampleRate === 0 ? 0 : frameCount / sampleRate,
			truePeakDb: !(truePeak > 0) ? null : 20 * Math.log10(truePeak),
			integratedLufs: Number.isFinite(integrated) ? integrated : null,
			loudnessRange: shortTerm.length === 0 ? null : computeLoudnessRange(shortTerm),
		};
	});

export const stats = async (inputs: Array<string>, options: StatsOptions): Promise<void> => {
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
		.argument("<inputs...>", "input WAV paths")
		.option("--json", "print JSON")
		.action(stats);
};
