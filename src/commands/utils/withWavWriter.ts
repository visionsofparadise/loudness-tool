import { nearestWritableBitDepth } from "../../wav/utils/wavFormat";
import { WavReader } from "../../wav/WavReader";
import { WavWriter, type WavSink } from "../../wav/WavWriter";

export const withWavWriter = async (
	inputPath: string,
	sink: WavSink,
	consume: (reader: WavReader, writer: WavWriter) => Promise<void>,
): Promise<void> => {
	const reader = await WavReader.open(inputPath);
	let writer: WavWriter | undefined;

	try {
		writer = await WavWriter.create(sink, {
			sampleRate: reader.format.sampleRate,
			channelCount: reader.format.channelCount,
			channelMask: reader.format.channelMask,
			bitDepth: nearestWritableBitDepth(reader.format.bitDepth),
			frameCount: reader.format.frameCount,
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
