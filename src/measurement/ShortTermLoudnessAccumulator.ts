import { BlockSumAccumulator } from "./BlockSumAccumulator";
import { KWeightedSquaredSum } from "./KWeightedSquaredSum";

const LUFS_OFFSET = -0.691;
const BLOCK_DURATION_SECONDS = 3;
const BLOCK_STEP_SECONDS = 0.1;
const FILE_LRA_TAIL_SECONDS = 1.5;
const FILE_LRA_TAIL_CHUNK_FRAMES = 8192;
const POWER_FLOOR = 1e-10;

// eslint-disable-next-line comment-rules/no-restricted-comments
// 3 s short-term windows at 100 ms and the 1.5 s zero-feed tail follow EBU Tech 3342 v3.0.

export class ShortTermLoudnessAccumulator {
	private readonly blockSize: number;
	private readonly blockStep: number;
	private readonly channelCount: number;
	private readonly tailFrames: number;
	private readonly weightedSquaredSum: KWeightedSquaredSum;
	private readonly blocks: BlockSumAccumulator;

	private outputBuffer: Float64Array = new Float64Array(0);
	private finalizedResult: Float64Array | undefined;
	private sourceFrames = 0;

	constructor(sampleRate: number, channelCount: number) {
		if (channelCount <= 0) {
			throw new Error(`ShortTermLoudnessAccumulator: channelCount must be positive, got ${channelCount}`);
		}

		this.blockSize = Math.round(BLOCK_DURATION_SECONDS * sampleRate);
		this.blockStep = Math.round(BLOCK_STEP_SECONDS * sampleRate);
		this.channelCount = channelCount;
		this.tailFrames = Math.round(FILE_LRA_TAIL_SECONDS * sampleRate);
		this.weightedSquaredSum = new KWeightedSquaredSum(sampleRate, channelCount);
		this.blocks = new BlockSumAccumulator(this.blockSize, this.blockStep);
	}

	push(channels: ReadonlyArray<Float64Array>, frameCount: number): void {
		if (this.finalizedResult !== undefined) {
			throw new Error("ShortTermLoudnessAccumulator: push after finalize");
		}

		if (frameCount > 0) {
			this.sourceFrames += frameCount;
		}

		this.pushWeighted(channels, frameCount);
	}

	get sourceWindowCount(): number {
		return this.sourceFrames < this.blockSize
			? 0
			: Math.floor((this.sourceFrames - this.blockSize) / this.blockStep) + 1;
	}

	finalize(): Float64Array {
		if (this.finalizedResult !== undefined) {
			return this.finalizedResult;
		}

		const tailFrames = this.tailFrames;

		if (tailFrames > 0) {
			const tailChunkFrames = Math.min(FILE_LRA_TAIL_CHUNK_FRAMES, tailFrames);
			const zeroChannel = new Float64Array(tailChunkFrames);
			const zeroChannels: Array<Float64Array> = [];

			for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex++) {
				zeroChannels.push(zeroChannel);
			}

			let remainingTailFrames = tailFrames;

			while (remainingTailFrames > 0) {
				const frames = Math.min(remainingTailFrames, tailChunkFrames);

				this.pushWeighted(zeroChannels, frames);
				remainingTailFrames -= frames;
			}
		}

		const closed = this.blocks.finalize();
		const series = new Float64Array(closed.length);
		const blockSize = this.blockSize;

		for (let index = 0; index < closed.length; index++) {
			series[index] = LUFS_OFFSET + 10 * Math.log10(Math.max((closed[index] ?? 0) / blockSize, POWER_FLOOR));
		}

		this.finalizedResult = series;

		return series;
	}

	private growOutputBuffer(frameCount: number): Float64Array {
		const current = this.outputBuffer;

		if (current.length >= frameCount) {
			return current;
		}

		const grown = new Float64Array(frameCount);

		this.outputBuffer = grown;

		return grown;
	}

	private pushWeighted(channels: ReadonlyArray<Float64Array>, frameCount: number): void {
		if (frameCount <= 0) {
			return;
		}

		const output = this.growOutputBuffer(frameCount);

		this.weightedSquaredSum.push(channels, frameCount, output);
		this.blocks.push(output, frameCount);
	}
}
