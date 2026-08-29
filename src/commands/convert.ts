import { Option, type Command } from "commander";
import { nearestWritableBitDepth, type WavBitDepth } from "../wav/utils/wavFormat";
import { WavReader, type AudioFormat } from "../wav/WavReader";
import { WavWriter } from "../wav/WavWriter";

export interface ConvertOptions {
	readonly output: string;
	readonly bitDepth?: WavBitDepth;
}

const summaryLineOf = (
	inputPath: string,
	format: AudioFormat,
	outputPath: string,
	outputBitDepth: WavBitDepth,
): string =>
	`${inputPath}: ${format.sampleRate} Hz, ${format.channelCount} ch, ${format.bitDepth}, ${(format.frameCount / format.sampleRate).toFixed(3)} s -> ${outputPath}: ${outputBitDepth}`;

export const convert = async (inputPath: string, options: ConvertOptions): Promise<void> => {
	const reader = await WavReader.open(inputPath);
	let writer: WavWriter | undefined;

	try {
		const outputBitDepth = options.bitDepth ?? nearestWritableBitDepth(reader.format.bitDepth);

		writer = await WavWriter.create(options.output, {
			sampleRate: reader.format.sampleRate,
			channelCount: reader.format.channelCount,
			bitDepth: outputBitDepth,
		});

		for await (const block of reader.blocks()) {
			await writer.write(block.channels);
		}

		await reader.close();
		await writer.close();

		console.log(summaryLineOf(inputPath, reader.format, options.output, outputBitDepth));
	} catch (error) {
		await writer?.abort();

		throw error;
	} finally {
		await reader.close();
	}
};

export const addConvertCommand = (program: Command): void => {
	program
		.command("convert")
		.description("Convert a WAV file, optionally changing bit depth")
		.argument("<input>", "Input WAV path")
		.requiredOption("-o, --output <path>", "Output WAV path")
		.addOption(new Option("--bit-depth <depth>", "Output bit depth").choices(["16", "24", "32", "32f"]))
		.action(convert);
};
