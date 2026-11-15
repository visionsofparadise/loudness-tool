import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { pushWavBlocks } from "./withWavReader";
import type { OversamplingFactor } from "../../measurement/TruePeakUpsampler";
import type { BlockSource } from "../../wav/WavReader";

export const measureTruePeak = async (
	source: BlockSource,
	oversampling: OversamplingFactor,
): Promise<{ readonly truePeak: number; readonly frameCount: number }> => {
	const accumulator = new TruePeakAccumulator(source.format.channelCount, oversampling);
	const frameCount = await pushWavBlocks(source, [accumulator]);

	return { truePeak: accumulator.finalize(), frameCount };
};
