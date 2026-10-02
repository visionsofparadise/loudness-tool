import { withWavWriter } from "./withWavWriter";
import type { WavSink } from "../../wav/WavWriter";

export const applyUniformGain = async (inputPath: string, sink: WavSink, gain: number): Promise<void> => {
	await withWavWriter(inputPath, sink, async (reader, writer) => {
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
