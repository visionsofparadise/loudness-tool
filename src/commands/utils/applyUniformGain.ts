import { nearestWritableBitDepth } from "../../wav/utils/wavFormat";
import { WavReader } from "../../wav/WavReader";
import { WavWriter } from "../../wav/WavWriter";

export const applyUniformGain = async (inputPath: string, outputPath: string, gain: number): Promise<void> => {
	const reader = await WavReader.open(inputPath);
	let writer: WavWriter | undefined;

	try {
		writer = await WavWriter.create(outputPath, {
			sampleRate: reader.format.sampleRate,
			channelCount: reader.format.channelCount,
			bitDepth: nearestWritableBitDepth(reader.format.bitDepth),
		});

		for await (const block of reader.blocks()) {
			for (const channel of block.channels) {
				for (let frameIndex = 0; frameIndex < channel.length; frameIndex++) {
					channel[frameIndex] = (channel[frameIndex] ?? 0) * gain;
				}
			}

			await writer.write(block.channels);
		}

		await reader.close();
		await writer.close();
	} catch (error: unknown) {
		await writer?.abort();

		throw error;
	} finally {
		await reader.close();
	}
};
