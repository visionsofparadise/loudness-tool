import { BlockSumAccumulator } from "./BlockSumAccumulator";
import { applyBs1770Gating } from "./gating";
import { KWeightedSquaredSum } from "./KWeightedSquaredSum";

const BLOCK_DURATION_SECONDS = 0.4;
const BLOCK_STEP_SECONDS = 0.1;

// eslint-disable-next-line comment-rules/no-restricted-comments
// K-weighting, 400 ms blocks, and integrated gating follow ITU-R BS.1770-5.

export class IntegratedLufsAccumulator {
	private readonly blockSize: number;
	private readonly weightedSquaredSum: KWeightedSquaredSum;
	private readonly blocks: BlockSumAccumulator;

	private outputBuffer: Float64Array = new Float64Array(0);
	private finalizedResult: number | undefined;

	constructor(sampleRate: number, weights: Float64Array) {
		if (weights.length <= 0) {
			throw new Error(`IntegratedLufsAccumulator: channelCount must be positive, got ${weights.length}`);
		}

		this.blockSize = Math.round(BLOCK_DURATION_SECONDS * sampleRate);

		const blockStep = Math.round(BLOCK_STEP_SECONDS * sampleRate);

		this.weightedSquaredSum = new KWeightedSquaredSum(sampleRate, weights);
		this.blocks = new BlockSumAccumulator(this.blockSize, blockStep);
	}

	push(channels: ReadonlyArray<Float64Array>, frameCount: number): void {
		if (this.finalizedResult !== undefined) {
			throw new Error("IntegratedLufsAccumulator: push after finalize");
		}

		if (frameCount <= 0) {
			return;
		}

		if (this.outputBuffer.length < frameCount) {
			this.outputBuffer = new Float64Array(frameCount);
		}

		this.weightedSquaredSum.push(channels, frameCount, this.outputBuffer);
		this.blocks.push(this.outputBuffer, frameCount);
	}

	finalize(): number {
		if (this.finalizedResult !== undefined) {
			return this.finalizedResult;
		}

		this.finalizedResult = applyBs1770Gating(this.blocks.finalize(), this.blockSize);

		return this.finalizedResult;
	}
}
