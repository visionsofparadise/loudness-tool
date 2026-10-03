import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { withWavWriter } from "../../utils/withWavWriter";
import { stretchFrameCountOf, type CrestLayout } from "./ladder";
import { allocateChannels, forEachStretchChunk, renderStretch } from "./render";
import { quantizerOf } from "./rounding";
import type { StretchRange } from "./regions";
import type { AudioOutput } from "../../utils/sinks";

export const applyWalk = async (args: {
	inputPath: string;
	output: AudioOutput;
	layout: CrestLayout;
	channelCount: number;
	walk: Int32Array;
}): Promise<number> => {
	const { inputPath, output, layout, channelCount, walk } = args;
	const accumulator = new TruePeakAccumulator(channelCount);
	const quantize = quantizerOf(output.bitDepth);
	const stretchOutput = allocateChannels(channelCount, layout.stretchFrames);
	const stepIndicesOf = (range: StretchRange): Array<number> => {
		const stepIndices = new Set<number>([layout.zeroStepIndex]);

		for (let stretchIndex = range.firstStretch; stretchIndex <= range.lastStretch + 1; stretchIndex++) {
			stepIndices.add(walk[stretchIndex] ?? layout.zeroStepIndex);
		}

		return [...stepIndices];
	};

	await withWavWriter(inputPath, output, async (reader, writer) => {
		await reader.close();
		await forEachStretchChunk({
			path: inputPath,
			layout,
			ranges: layout.stretchCount === 0 ? [] : [{ firstStretch: 0, lastStretch: layout.stretchCount - 1 }],
			stepIndicesOf,
			handle: async (chunk) => {
				const chunkOutput = allocateChannels(channelCount, chunk.stretchCount * layout.stretchFrames);
				let written = 0;

				for (let offset = 0; offset < chunk.stretchCount; offset++) {
					const stretchIndex = chunk.firstStretch + offset;

					renderStretch({
						chunk,
						layout,
						stretchIndex,
						beginStepIndex: walk[stretchIndex] ?? layout.zeroStepIndex,
						endStepIndex: walk[stretchIndex + 1] ?? layout.zeroStepIndex,
						quantize,
						output: stretchOutput,
					});

					const frameCount = stretchFrameCountOf(layout, stretchIndex);

					for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
						chunkOutput[channelIndex]?.set(
							stretchOutput[channelIndex]?.subarray(0, frameCount) ?? new Float64Array(0),
							written,
						);
					}

					written += frameCount;
				}

				const frames = chunkOutput.map((channel) => channel.subarray(0, written));

				accumulator.push(frames, written);

				await writer.writeQuantized(frames);
			},
		});
	});

	return accumulator.finalize();
};
