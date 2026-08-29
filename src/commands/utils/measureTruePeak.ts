import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { pushWavBlocks, withWavReader } from "./withWavReader";
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
}> =>
	withWavReader(path, async (reader) => {
		const accumulator = new TruePeakAccumulator(reader.format.channelCount);

		await pushWavBlocks(reader, [accumulator]);

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
	});
