import { TAPS_PER_PHASE, TruePeakUpsampler } from "../../../measurement/TruePeakUpsampler";
import { candidatesOf, costTableOf, WindowedSolve } from "./blend";
import { stretchFrameCountOf, type CrestLayout } from "./layout";
import {
	chunkFrameCountOf,
	chunkRangeOf,
	chunkStretchesOf,
	forEachStretchChunk,
	OVERSAMPLE_FACTOR,
	type StretchChunk,
} from "./render";
import { SourceWindow } from "./SourceWindow";

const LEAD_FRAMES = TAPS_PER_PHASE;

interface DispersedFrames {
	readonly channels: ReadonlyArray<Float64Array>;
	readonly firstFrame: number;
	readonly lead: ReadonlyArray<Float64Array> | undefined;
}

interface UpsampledChannel {
	readonly current: Float64Array;
	readonly dispersed: Float64Array;
}

class StretchScorer {
	private readonly layout: CrestLayout;
	private readonly currentInput: Float64Array;
	private readonly dispersedInput: Float64Array;
	private readonly upsampled: ReadonlyArray<UpsampledChannel>;

	constructor(layout: CrestLayout, channelCount: number) {
		const inputFrames = LEAD_FRAMES + layout.stretchFrames;

		this.layout = layout;
		this.currentInput = new Float64Array(inputFrames);
		this.dispersedInput = new Float64Array(inputFrames);
		this.upsampled = Array.from({ length: channelCount }, () => ({
			current: new Float64Array(inputFrames * OVERSAMPLE_FACTOR),
			dispersed: new Float64Array(inputFrames * OVERSAMPLE_FACTOR),
		}));
	}

	score(args: {
		stretchIndex: number;
		window: SourceWindow;
		dispersed: DispersedFrames;
		threshold: number;
	}): Float64Array {
		const { stretchIndex, window, dispersed, threshold } = args;
		const { layout, currentInput, dispersedInput, upsampled } = this;
		const firstFrame = stretchIndex * layout.stretchFrames;
		const frameCount = stretchFrameCountOf(layout, stretchIndex);
		const leadFirst = Math.max(0, firstFrame - LEAD_FRAMES);
		const inputFrames = firstFrame + frameCount - leadFirst;
		const keepFirst = (firstFrame - leadFirst) * OVERSAMPLE_FACTOR;
		const keepEnd = keepFirst + frameCount * OVERSAMPLE_FACTOR;

		for (const [channelIndex, channel] of upsampled.entries()) {
			const currentChannel = window.channels[channelIndex] ?? new Float64Array(0);
			const dispersedChannel = dispersed.channels[channelIndex] ?? new Float64Array(0);
			const leadChannel = dispersed.lead?.[channelIndex];

			for (let offset = 0; offset < inputFrames; offset++) {
				const frame = leadFirst + offset;
				const dispersedOffset = frame - dispersed.firstFrame;

				currentInput[offset] = currentChannel[frame - window.firstFrame] ?? 0;

				if (dispersedOffset >= 0) {
					dispersedInput[offset] = dispersedChannel[dispersedOffset] ?? 0;
				} else if (leadChannel === undefined) {
					throw new Error(`solveStage: stretch ${stretchIndex} has no dispersed lead-in before frame ${frame}`);
				} else {
					dispersedInput[offset] = leadChannel[LEAD_FRAMES + dispersedOffset] ?? 0;
				}
			}

			new TruePeakUpsampler().upsample(currentInput, inputFrames, channel.current);
			new TruePeakUpsampler().upsample(dispersedInput, inputFrames, channel.dispersed);
		}

		return costTableOf(
			candidatesOf({
				current: upsampled.map((channel) => channel.current.subarray(keepFirst, keepEnd)),
				dispersed: upsampled.map((channel) => channel.dispersed.subarray(keepFirst, keepEnd)),
				frameCount,
				stretchFrames: layout.stretchFrames,
				threshold,
			}),
		);
	}
}

const leadOf = (chunk: StretchChunk, layout: CrestLayout, stepIndex: number): Array<Float64Array> | undefined => {
	const frameCount = chunkFrameCountOf(layout, chunk);

	if (frameCount < LEAD_FRAMES) {
		return undefined;
	}

	return (chunk.dispersed[stepIndex] ?? []).map((channel) => channel.slice(frameCount - LEAD_FRAMES, frameCount));
};

const seedStage = async (args: {
	sourcePath: string;
	currentPath: string;
	layout: CrestLayout;
	stepIndex: number;
	solve: WindowedSolve;
}): Promise<void> => {
	const { sourcePath, currentPath, layout, stepIndex, solve } = args;
	const { seedStretch } = solve;
	const chunkStretches = chunkStretchesOf(layout);
	const seedChunk = Math.floor(seedStretch / chunkStretches);
	const isChunkFirst = seedStretch % chunkStretches === 0 && seedStretch > 0;
	const seedFirstFrame = seedStretch * layout.stretchFrames;
	const coverFirst = Math.max(0, seedFirstFrame - LEAD_FRAMES);
	const window = await SourceWindow.open(currentPath, layout.stretchFrames + LEAD_FRAMES);
	const scorer = new StretchScorer(layout, window.format.channelCount);
	let lead: Array<Float64Array> | undefined;

	try {
		await window.cover(coverFirst, seedFirstFrame + stretchFrameCountOf(layout, seedStretch) - coverFirst);
		await forEachStretchChunk({
			path: sourcePath,
			layout,
			ranges: isChunkFirst
				? [chunkRangeOf(layout, seedChunk - 1), chunkRangeOf(layout, seedChunk)]
				: [chunkRangeOf(layout, seedChunk)],
			stepIndicesOf: () => [stepIndex],
			handle: (chunk) => {
				if (chunk.firstStretch !== seedChunk * chunkStretches) {
					lead = leadOf(chunk, layout, stepIndex);

					return;
				}

				solve.seed(
					scorer.score({
						stretchIndex: seedStretch,
						window,
						dispersed: { channels: chunk.dispersed[stepIndex] ?? [], firstFrame: chunk.firstFrame, lead },
						threshold: solve.seedThreshold,
					}),
				);
			},
		});
	} finally {
		await window.close();
	}
};

const forwardChunksOf = (layout: CrestLayout, near: Uint8Array): Array<number> => {
	const chunkStretches = chunkStretchesOf(layout);
	const chunks = new Set<number>();

	for (let stretchIndex = 0; stretchIndex < near.length; stretchIndex++) {
		if (near[stretchIndex] !== 1) {
			continue;
		}

		const chunkIndex = Math.floor(stretchIndex / chunkStretches);

		if (stretchIndex % chunkStretches === 0 && stretchIndex > 0) {
			chunks.add(chunkIndex - 1);
		}

		chunks.add(chunkIndex);
	}

	return [...chunks].sort((first, second) => first - second);
};

export const solveStage = async (args: {
	sourcePath: string;
	currentPath: string;
	layout: CrestLayout;
	stepIndex: number;
	peaks: Float64Array;
}): Promise<WindowedSolve> => {
	const { sourcePath, currentPath, layout, stepIndex, peaks } = args;
	const solve = new WindowedSolve({ peaks });

	if (layout.stretchCount === 0) {
		return solve;
	}

	await seedStage({ sourcePath, currentPath, layout, stepIndex, solve });

	const chunkStretches = chunkStretchesOf(layout);
	const window = await SourceWindow.open(currentPath, chunkStretches * layout.stretchFrames + LEAD_FRAMES);
	const scorer = new StretchScorer(layout, window.format.channelCount);
	let advanced = 0;
	let carry: { readonly chunkIndex: number; readonly lead: Array<Float64Array> | undefined } | undefined;

	try {
		await forEachStretchChunk({
			path: sourcePath,
			layout,
			ranges: forwardChunksOf(layout, solve.nearStretches()).map((chunkIndex) => chunkRangeOf(layout, chunkIndex)),
			stepIndicesOf: () => [stepIndex],
			handle: async (chunk) => {
				const chunkIndex = chunk.firstStretch / chunkStretches;
				const lead = carry?.chunkIndex === chunkIndex - 1 ? carry.lead : undefined;
				const dispersed = { channels: chunk.dispersed[stepIndex] ?? [], firstFrame: chunk.firstFrame, lead };

				for (; advanced < chunk.firstStretch; advanced++) {
					solve.advance(advanced, undefined);
				}

				await window.cover(chunk.firstFrame - LEAD_FRAMES, chunkFrameCountOf(layout, chunk) + LEAD_FRAMES);

				for (; advanced < chunk.firstStretch + chunk.stretchCount; advanced++) {
					solve.advance(
						advanced,
						solve.isNear(advanced)
							? scorer.score({ stretchIndex: advanced, window, dispersed, threshold: solve.threshold() })
							: undefined,
					);
				}

				carry = { chunkIndex, lead: leadOf(chunk, layout, stepIndex) };
			},
		});

		for (; advanced < layout.stretchCount; advanced++) {
			solve.advance(advanced, undefined);
		}
	} finally {
		await window.close();
	}

	return solve;
};
