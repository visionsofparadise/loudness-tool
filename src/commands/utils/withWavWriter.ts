import { WavReader } from "../../wav/WavReader";
import { WavWriter } from "../../wav/WavWriter";
import type { AudioOutput } from "./sinks";

export const withWavWriter = async (
	inputPath: string,
	output: AudioOutput,
	consume: (reader: WavReader, writer: WavWriter) => Promise<void>,
): Promise<void> => {
	const reader = await WavReader.open(inputPath);
	let writer: WavWriter | undefined;

	try {
		const format = {
			sampleRate: reader.format.sampleRate,
			channelCount: reader.format.channelCount,
			channelMask: output.channelMask,
			bitDepth: output.bitDepth,
			frameCount: reader.format.frameCount,
		};

		writer =
			output.container === "wav"
				? await WavWriter.create(output.sink, format)
				: await WavWriter.createRaw(output.sink, format);

		await consume(reader, writer);
		await reader.close();
		await writer.close();
	} catch (error: unknown) {
		await writer?.abort();

		throw error;
	} finally {
		await reader.close();
	}
};
