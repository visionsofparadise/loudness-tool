import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { WavReader } from "../../wav/WavReader";
import type { SourceBitDepth } from "../../wav/utils/wavFormat";

export const measureTruePeak = async (
	path: string,
): Promise<{
	readonly path: string;
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly bitDepth: SourceBitDepth;
	readonly durationSeconds: number;
	readonly frameCount: number;
	readonly truePeak: number;
}> => {
	const reader = await WavReader.open(path);

	try {
		const accumulator = new TruePeakAccumulator(reader.format.channelCount);

		for await (const block of reader.blocks()) {
			accumulator.push(block.channels, block.channels[0]?.length ?? 0);
		}

		const { sampleRate, channelCount, bitDepth, frameCount } = reader.format;

		return {
			path,
			sampleRate,
			channelCount,
			bitDepth,
			durationSeconds: sampleRate === 0 ? 0 : frameCount / sampleRate,
			frameCount,
			truePeak: accumulator.finalize(),
		};
	} finally {
		await reader.close();
	}
};
