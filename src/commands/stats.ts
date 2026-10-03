import { channelWeightsOf } from "../measurement/channelWeights";
import { IntegratedLufsAccumulator } from "../measurement/IntegratedLufsAccumulator";
import { computeLoudnessRange } from "../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../measurement/ShortTermLoudnessAccumulator";
import { TruePeakAccumulator } from "../measurement/TruePeakAccumulator";
import { linearToDb } from "../utils/db";
import { writeTextToStream } from "../utils/writeToStream";
import { withAudioInput } from "./utils/AudioInput";
import { streamScopesOf } from "./utils/AudioProgram";
import { descriptorOf } from "./utils/stdioPath";
import { DEFAULT_STREAM_OPTIONS, type StreamOptions } from "./utils/streamOptions";
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
	readonly inputStreams?: ReadonlyArray<StreamOptions>;
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

const measureStats = async (inputPath: string, stream: StreamOptions): Promise<StatsJson> =>
	withAudioInput(
		inputPath,
		{ replayable: false, scratchDirectory: undefined, stream, output: undefined },
		async (input) =>
			input.withFirstPass(async (source) => {
				const { sampleRate, channelCount, channelMask, bitDepth } = source.format;
				const weights = channelWeightsOf(channelCount, channelMask);
				const truePeakAccumulator = new TruePeakAccumulator(channelCount);
				const lufsAccumulator = new IntegratedLufsAccumulator(sampleRate, weights);
				const shortTermAccumulator = new ShortTermLoudnessAccumulator(sampleRate, weights);

				const frameCount = await pushWavBlocks(source, [
					truePeakAccumulator,
					lufsAccumulator,
					shortTermAccumulator,
				]);

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

const descriptorOrUndefined = (inputPath: string): number | undefined => {
	try {
		return descriptorOf(inputPath, "input");
	} catch {
		return undefined;
	}
};

const assertDescriptorsReadOnce = (inputs: ReadonlyArray<string>): void => {
	const seen = new Set<number>();

	for (const inputPath of inputs) {
		const descriptor = descriptorOrUndefined(inputPath);

		if (descriptor !== undefined && seen.has(descriptor)) {
			throw new Error(
				descriptor === 0 ? "stdin can be read once" : `file descriptor ${descriptor} can be read once`,
			);
		}

		if (descriptor !== undefined) {
			seen.add(descriptor);
		}
	}
};

export const stats = async (inputs: Array<string>, options: StatsOptions): Promise<void> => {
	assertDescriptorsReadOnce(inputs);

	const results: Array<StatsJson> = [];
	let failed = false;

	for (const [index, inputPath] of inputs.entries()) {
		let result: StatsJson | undefined;

		try {
			result = await measureStats(inputPath, options.inputStreams?.[index] ?? DEFAULT_STREAM_OPTIONS);
		} catch (error: unknown) {
			failed = true;
			process.stderr.write(`error: ${errorMessageOf(error, inputPath)}\n`);
		}

		if (result !== undefined) {
			results.push(result);

			if (options.json !== true) {
				await writeTextToStream(process.stdout, `${results.length > 1 ? "\n" : ""}${formatHuman(result)}`);
			}
		}
	}

	if (options.json === true) {
		await writeTextToStream(process.stdout, `${JSON.stringify(results)}\n`);
	}

	if (failed) {
		process.exitCode = 1;
	}
};

export const addStatsCommand = (program: Command): void => {
	program
		.command("stats")
		.description("Report true-peak, integrated loudness, and loudness range of audio inputs")
		.argument("<inputs...>", "input paths, WAV unless -f names a raw format, or - or pipe: for a pipe")
		.option("--json", "print JSON")
		.action(async (inputs: Array<string>, options: StatsOptions, command: Command) =>
			stats(inputs, { ...options, inputStreams: streamScopesOf(command).inputs }),
		);
};
