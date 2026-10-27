import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { withWavWriter } from "../../utils/withWavWriter";
import { weightOf } from "./blend";
import { chunkFrameCountOf, chunkRangeOf, chunkStretchesOf, forEachStretchChunk, type StretchChunk } from "./render";
import { quantizerOf } from "./rounding";
import { SourceWindow } from "./SourceWindow";
import { StretchPeakMeter } from "./StretchPeakMeter";
import type { CrestLayout } from "./layout";
import type { AudioOutput } from "../../utils/sinks";

const blendedChunksOf = (layout: CrestLayout, path: Int32Array): Array<number> => {
	const chunkStretches = chunkStretchesOf(layout);
	const chunks: Array<number> = [];

	for (let stretchIndex = 0; stretchIndex < layout.stretchCount; stretchIndex++) {
		const chunkIndex = Math.floor(stretchIndex / chunkStretches);

		if (
			chunks[chunks.length - 1] !== chunkIndex &&
			((path[stretchIndex] ?? 0) > 0 || (path[stretchIndex + 1] ?? 0) > 0)
		) {
			chunks.push(chunkIndex);
		}
	}

	return chunks;
};

export const renderStage = async (args: {
	sourcePath: string;
	currentPath: string;
	layout: CrestLayout;
	stepIndex: number;
	path: Int32Array;
	output: AudioOutput;
	isLast: boolean;
}): Promise<{ readonly peaks: Float64Array; readonly truePeak: number }> => {
	const { sourcePath, currentPath, layout, stepIndex, path, output, isLast } = args;
	const quantize = isLast ? quantizerOf(output.bitDepth) : (sample: number): number => sample;
	const capacity = chunkStretchesOf(layout) * layout.stretchFrames;
	let result: { readonly peaks: Float64Array; readonly truePeak: number } = {
		peaks: new Float64Array(0),
		truePeak: 0,
	};

	await withWavWriter(currentPath, output, async (reader, writer) => {
		const { channelCount } = reader.format;

		await reader.close();

		const meter = new StretchPeakMeter({ stretchFrames: layout.stretchFrames, channelCount });
		const accumulator = new TruePeakAccumulator(channelCount);
		const frames = Array.from({ length: channelCount }, () => new Float64Array(capacity));
		const window = await SourceWindow.open(currentPath, capacity);
		let writtenFrames = 0;

		const emit = async (frameCount: number): Promise<void> => {
			const written = frames.map((channel) => channel.subarray(0, frameCount));

			meter.push(written, frameCount);
			accumulator.push(written, frameCount);

			await (isLast ? writer.writeQuantized(written) : writer.write(written));

			writtenFrames += frameCount;
		};

		const copyThrough = async (endFrame: number): Promise<void> => {
			while (writtenFrames < endFrame) {
				const frameCount = Math.min(capacity, endFrame - writtenFrames);

				await window.cover(writtenFrames, frameCount);

				for (const [channelIndex, target] of frames.entries()) {
					const current = window.channels[channelIndex] ?? new Float64Array(0);

					for (let offset = 0; offset < frameCount; offset++) {
						target[offset] = quantize(current[offset] ?? 0);
					}
				}

				await emit(frameCount);
			}
		};

		const blendChunk = async (chunk: StretchChunk): Promise<void> => {
			const frameCount = chunkFrameCountOf(layout, chunk);

			await window.cover(chunk.firstFrame, frameCount);

			for (const [channelIndex, target] of frames.entries()) {
				const current = window.channels[channelIndex] ?? new Float64Array(0);
				const dispersed = chunk.dispersed[stepIndex]?.[channelIndex] ?? new Float64Array(0);

				for (let offset = 0; offset < frameCount; offset++) {
					const sample = current[offset] ?? 0;
					const weight = weightOf(path, chunk.firstFrame + offset, layout.stretchFrames);

					target[offset] = quantize(weight > 0 ? sample + weight * ((dispersed[offset] ?? 0) - sample) : sample);
				}
			}

			await emit(frameCount);
		};

		try {
			await forEachStretchChunk({
				path: sourcePath,
				layout,
				ranges: blendedChunksOf(layout, path).map((chunkIndex) => chunkRangeOf(layout, chunkIndex)),
				stepIndicesOf: () => [stepIndex],
				handle: async (chunk) => {
					await copyThrough(chunk.firstFrame);
					await blendChunk(chunk);
				},
			});
			await copyThrough(layout.frameCount);
		} finally {
			await window.close();
		}

		result = { peaks: meter.finish(), truePeak: accumulator.finalize() };
	});

	return result;
};
