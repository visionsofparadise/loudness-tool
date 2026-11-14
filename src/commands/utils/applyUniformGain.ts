import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { quantizerOf } from "../../wav/utils/sampleCodec";
import { withWavWriter } from "./withWavWriter";
import type { AudioOutput } from "./sinks";

export const applyUniformGain = async (
	inputPath: string,
	output: AudioOutput,
	gain: number,
): Promise<{ truePeak: number }> => {
	const quantize = quantizerOf(output.bitDepth);
	let truePeak = 0;

	await withWavWriter(inputPath, output, async (reader, writer) => {
		const accumulator = new TruePeakAccumulator(reader.format.channelCount);

		for await (const block of reader.blocks()) {
			for (const channel of block.channels) {
				for (let frameIndex = 0; frameIndex < channel.length; frameIndex++) {
					channel[frameIndex] = quantize((channel[frameIndex] ?? 0) * gain);
				}
			}

			accumulator.push(block.channels, block.channels[0]?.length ?? 0);
			await writer.write(block.channels);
		}

		truePeak = accumulator.finalize();
	});

	return { truePeak };
};
