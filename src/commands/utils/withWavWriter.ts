import { nearestWritableBitDepth } from "../../wav/utils/wavFormat";
import { WavReader } from "../../wav/WavReader";
import { WavWriter } from "../../wav/WavWriter";

export const withWavWriter = async (
	inputPath: string,
	outputPath: string,
	consume: (reader: WavReader, writer: WavWriter) => Promise<void>,
): Promise<void> => {
	const reader = await WavReader.open(inputPath);
	let writer: WavWriter | undefined;

	try {
		writer = await WavWriter.create(outputPath, {
			sampleRate: reader.format.sampleRate,
			channelCount: reader.format.channelCount,
			bitDepth: nearestWritableBitDepth(reader.format.bitDepth),
		});

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
