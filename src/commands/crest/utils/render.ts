import { TruePeakUpsampler } from "../../../measurement/TruePeakUpsampler";
import { Disperser } from "./Disperser";
import { stretchFrameCountOf, type CrestLayout } from "./ladder";
import { SourceWindow } from "./SourceWindow";
import type { StretchRange } from "./regions";

export const OVERSAMPLE_FACTOR = 4;
export const TRUE_PEAK_TAIL_FRAMES = 11;

const IDENTITY_TOLERANCE = 1e-10;

const TARGET_CHUNK_FRAMES = 16384;

export interface StretchChunk {
	readonly dispersed: ReadonlyArray<ReadonlyArray<Float64Array>>;
	readonly firstFrame: number;
	readonly firstStretch: number;
	readonly stretchCount: number;
}

export interface StretchMeasure {
	readonly peak: number;
	readonly identicalFrames: number;
	readonly head: Float64Array;
	readonly carry: Float64Array;
}

export const allocateChannels = (channelCount: number, frameCount: number): Array<Float64Array> => {
	const channels: Array<Float64Array> = [];

	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		channels.push(new Float64Array(frameCount));
	}

	return channels;
};

export const forEachStretchChunk = async (args: {
	path: string;
	layout: CrestLayout;
	ranges: ReadonlyArray<StretchRange>;
	stepIndicesOf: (range: StretchRange) => ReadonlyArray<number>;
	handle: (chunk: StretchChunk) => void | Promise<void>;
}): Promise<void> => {
	const { path, layout, ranges, stepIndicesOf, handle } = args;
	const chunkStretches = Math.max(1, Math.floor(TARGET_CHUNK_FRAMES / layout.stretchFrames));
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
				const frameCount = Math.min(layout.frameCount - firstFrame, stretchCount * layout.stretchFrames);
				const stepIndices = stepIndicesOf({ firstStretch: first, lastStretch: first + stretchCount - 1 });

				await window.cover(firstFrame - layout.maxStepFrames, frameCount + 2 * layout.maxStepFrames);
				disperser.disperse({
					window: window.channels,
					windowFirstFrame: firstFrame - layout.maxStepFrames,
					firstFrame,
					frameCount,
					stepIndices: stepIndices.includes(layout.zeroStepIndex)
						? stepIndices
						: [...stepIndices, layout.zeroStepIndex],
					targets: dispersed,
				});

				await handle({ dispersed, firstFrame, firstStretch: first, stretchCount });
			}
		}
	} finally {
		await window.close();
	}
};

export const renderStretch = (args: {
	chunk: StretchChunk;
	layout: CrestLayout;
	stretchIndex: number;
	beginStepIndex: number;
	endStepIndex: number;
	quantize: (sample: number) => number;
	output: ReadonlyArray<Float64Array>;
}): void => {
	const { chunk, layout, stretchIndex, beginStepIndex, endStepIndex, quantize, output } = args;
	const frameCount = stretchFrameCountOf(layout, stretchIndex);
	const offset = stretchIndex * layout.stretchFrames - chunk.firstFrame;
	const beginChannels = chunk.dispersed[beginStepIndex] ?? [];
	const endChannels = chunk.dispersed[endStepIndex] ?? [];
	const sourceChannels = chunk.dispersed[layout.zeroStepIndex] ?? [];

	for (let channelIndex = 0; channelIndex < output.length; channelIndex++) {
		const target = output[channelIndex];
		const begin = beginChannels[channelIndex];
		const end = endChannels[channelIndex];
		const source = sourceChannels[channelIndex];

		if (target === undefined || begin === undefined || end === undefined || source === undefined) {
			continue;
		}

		if (beginStepIndex === endStepIndex) {
			for (let index = 0; index < frameCount; index++) {
				target[index] = quantize(begin[offset + index] ?? 0);
			}

			continue;
		}

		for (let index = 0; index < frameCount; index++) {
			const weight = (index + 1) / layout.stretchFrames;
			const blended = (begin[offset + index] ?? 0) * (1 - weight) + (end[offset + index] ?? 0) * weight;
			const held = source[offset + index] ?? 0;

			target[index] = quantize(Math.abs(blended - held) <= IDENTITY_TOLERANCE ? held : blended);
		}
	}
};

export const measureStretch = (args: {
	output: ReadonlyArray<Float64Array>;
	sourceFrames: ReadonlyArray<Float64Array>;
	frameCount: number;
	scratch: Float64Array;
	tailScratch: Float64Array;
}): StretchMeasure => {
	const { output, sourceFrames, frameCount, scratch, tailScratch } = args;
	const channelCount = output.length;
	const head = new Float64Array(TRUE_PEAK_TAIL_FRAMES * OVERSAMPLE_FACTOR * channelCount);
	const carry = new Float64Array(TRUE_PEAK_TAIL_FRAMES * OVERSAMPLE_FACTOR * channelCount);
	const headFrames = Math.min(TRUE_PEAK_TAIL_FRAMES, frameCount);
	let peak = 0;

	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		const samples = output[channelIndex];

		if (samples === undefined) {
			continue;
		}

		for (let index = 0; index < frameCount; index++) {
			const magnitude = Math.abs(samples[index] ?? 0);

			if (magnitude > peak) {
				peak = magnitude;
			}
		}

		const upsampler = new TruePeakUpsampler();

		upsampler.upsample(samples, frameCount, scratch);

		for (let offset = 0; offset < headFrames; offset++) {
			for (let phase = 0; phase < OVERSAMPLE_FACTOR; phase++) {
				head[(offset * OVERSAMPLE_FACTOR + phase) * channelCount + channelIndex] =
					scratch[offset * OVERSAMPLE_FACTOR + phase] ?? 0;
			}
		}

		for (
			let position = TRUE_PEAK_TAIL_FRAMES * OVERSAMPLE_FACTOR;
			position < frameCount * OVERSAMPLE_FACTOR;
			position++
		) {
			const magnitude = Math.abs(scratch[position] ?? 0);

			if (magnitude > peak) {
				peak = magnitude;
			}
		}

		upsampler.flush(tailScratch);

		for (let offset = 0; offset < TRUE_PEAK_TAIL_FRAMES; offset++) {
			for (let phase = 0; phase < OVERSAMPLE_FACTOR; phase++) {
				carry[(offset * OVERSAMPLE_FACTOR + phase) * channelCount + channelIndex] =
					tailScratch[offset * OVERSAMPLE_FACTOR + phase] ?? 0;
			}
		}
	}

	let identicalFrames = 0;

	for (let index = 0; index < frameCount; index++) {
		let isIdentical = true;

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			if ((output[channelIndex]?.[index] ?? 0) !== (sourceFrames[channelIndex]?.[index] ?? 0)) {
				isIdentical = false;

				break;
			}
		}

		if (isIdentical) {
			identicalFrames++;
		}
	}

	return { peak, identicalFrames, head, carry };
};
