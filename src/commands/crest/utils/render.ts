import { Disperser } from "./Disperser";
import { SourceWindow } from "./SourceWindow";
import type { CrestLayout } from "./layout";

export { OVERSAMPLE_FACTOR } from "./CandidateUpsampler";

const TARGET_CHUNK_FRAMES = 16384;

export interface StretchRange {
	readonly firstStretch: number;
	readonly lastStretch: number;
}

export interface StretchChunk {
	readonly dispersed: ReadonlyArray<ReadonlyArray<Float64Array>>;
	readonly firstFrame: number;
	readonly firstStretch: number;
	readonly stretchCount: number;
}

const allocateChannels = (channelCount: number, frameCount: number): Array<Float64Array> => {
	const channels: Array<Float64Array> = [];

	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		channels.push(new Float64Array(frameCount));
	}

	return channels;
};

export const chunkStretchesOf = (layout: CrestLayout): number =>
	Math.max(1, Math.floor(TARGET_CHUNK_FRAMES / layout.stretchFrames));

export const chunkRangeOf = (layout: CrestLayout, chunkIndex: number): StretchRange => {
	const chunkStretches = chunkStretchesOf(layout);

	return {
		firstStretch: chunkIndex * chunkStretches,
		lastStretch: Math.min(layout.stretchCount - 1, (chunkIndex + 1) * chunkStretches - 1),
	};
};

export const chunkFrameCountOf = (
	layout: CrestLayout,
	chunk: { readonly firstStretch: number; readonly stretchCount: number },
): number =>
	Math.min(layout.frameCount - chunk.firstStretch * layout.stretchFrames, chunk.stretchCount * layout.stretchFrames);

export const forEachStretchChunk = async (args: {
	path: string;
	layout: CrestLayout;
	ranges: ReadonlyArray<StretchRange>;
	stepIndicesOf: (range: StretchRange) => ReadonlyArray<number>;
	handle: (chunk: StretchChunk) => void | Promise<void>;
}): Promise<void> => {
	const { path, layout, ranges, stepIndicesOf, handle } = args;
	const chunkStretches = chunkStretchesOf(layout);
	const chunkFrames = chunkStretches * layout.stretchFrames;
	const disperser = Disperser.of(layout.steps, layout.maxStepFrames);
	const window = await SourceWindow.open(path, chunkFrames + 2 * layout.maxStepFrames);
	const channelCount = window.format.channelCount;
	const dispersed = layout.steps.map(() => allocateChannels(channelCount, chunkFrames));

	try {
		for (const range of ranges) {
			for (let first = range.firstStretch; first <= range.lastStretch; first += chunkStretches) {
				const stretchCount = Math.min(chunkStretches, range.lastStretch - first + 1);
				const firstFrame = first * layout.stretchFrames;
				const frameCount = chunkFrameCountOf(layout, { firstStretch: first, stretchCount });

				await window.cover(firstFrame - layout.maxStepFrames, frameCount + 2 * layout.maxStepFrames);
				disperser.disperse({
					window: window.channels,
					windowFirstFrame: firstFrame - layout.maxStepFrames,
					firstFrame,
					frameCount,
					stepIndices: stepIndicesOf({ firstStretch: first, lastStretch: first + stretchCount - 1 }),
					targets: dispersed,
				});

				await handle({ dispersed, firstFrame, firstStretch: first, stretchCount });
			}
		}
	} finally {
		await window.close();
	}
};
