import { clampTestOf, quantizerOf } from "../../wav/utils/sampleCodec";
import { withWavWriter } from "./withWavWriter";
import type { AudioOutput } from "./sinks";
import type { BlockConsumer } from "./withWavReader";

export const applyUniformGain = async (
	inputPath: string,
	output: AudioOutput,
	gain: number,
	meters: ReadonlyArray<BlockConsumer> = [],
): Promise<{ clampedSamples: number }> => {
	const quantize = quantizerOf(output.bitDepth);
	const isClamped = clampTestOf(output.bitDepth);
	let clampedSamples = 0;

	await withWavWriter(inputPath, output, async (reader, writer) => {
		for await (const block of reader.blocks()) {
			for (const channel of block.channels) {
				for (let frameIndex = 0; frameIndex < channel.length; frameIndex++) {
					const sample = (channel[frameIndex] ?? 0) * gain;

					if (isClamped(sample)) {
						clampedSamples++;
					}

					channel[frameIndex] = quantize(sample);
				}
			}

			for (const meter of meters) {
				meter.push(block.channels, block.channels[0]?.length ?? 0);
			}

			await writer.write(block.channels);
		}
	});

	return { clampedSamples };
};
