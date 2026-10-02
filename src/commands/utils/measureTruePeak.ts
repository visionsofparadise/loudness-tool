import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { pushWavBlocks } from "./withWavReader";
import type { BlockSource } from "../../wav/WavReader";

export const measureTruePeak = async (
	source: BlockSource,
): Promise<{ readonly truePeak: number; readonly frameCount: number }> => {
	const accumulator = new TruePeakAccumulator(source.format.channelCount);
	const frameCount = await pushWavBlocks(source, [accumulator]);

	return { truePeak: accumulator.finalize(), frameCount };
};
