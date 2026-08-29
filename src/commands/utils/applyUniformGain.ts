import { withWavWriter } from "./withWavWriter";

export const applyUniformGain = async (inputPath: string, outputPath: string, gain: number): Promise<void> => {
	await withWavWriter(inputPath, outputPath, async (reader, writer) => {
		for await (const block of reader.blocks()) {
			for (const channel of block.channels) {
				for (let frameIndex = 0; frameIndex < channel.length; frameIndex++) {
					channel[frameIndex] = (channel[frameIndex] ?? 0) * gain;
				}
			}

			await writer.write(block.channels);
		}
	});
};
