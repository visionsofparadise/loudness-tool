import { TruePeakUpsampler } from "../../../measurement/TruePeakUpsampler";
import { linearToDb } from "../../../utils/db";

const OVERSAMPLE_FACTOR = 4;
const FLUSH_OUTPUT_SAMPLES = 11 * OVERSAMPLE_FACTOR;

export class TruePeakArgmaxAccumulator {
	private readonly upsamplers: ReadonlyArray<TruePeakUpsampler>;
	private upsampleScratch: Float64Array = new Float64Array(0);
	private runningMax = 0;
	private peakInputSample = 0;
	private inputBase = 0;
	private finalized: { truePeakDb: number; peakInputSample: number } | undefined;

	constructor(channelCount: number) {
		if (!Number.isInteger(channelCount) || channelCount < 1) {
			throw new Error(`TruePeakArgmaxAccumulator: channelCount must be positive, got ${channelCount}`);
		}

		this.upsamplers = Array.from({ length: channelCount }, () => new TruePeakUpsampler());
	}

	push(channels: ReadonlyArray<Float64Array>, frameCount: number): void {
		if (this.finalized !== undefined) {
			throw new Error("TruePeakArgmaxAccumulator: push after finalize");
		}

		if (channels.length !== this.upsamplers.length) {
			throw new Error(
				`TruePeakArgmaxAccumulator: push got ${channels.length} channels, expected ${this.upsamplers.length}`,
			);
		}

		if (frameCount <= 0) {
			return;
		}

		const outputLength = frameCount * OVERSAMPLE_FACTOR;

		if (this.upsampleScratch.length < outputLength) {
			this.upsampleScratch = new Float64Array(outputLength);
		}

		for (let channelIndex = 0; channelIndex < this.upsamplers.length; channelIndex++) {
			const samples = channels[channelIndex];
			const upsampler = this.upsamplers[channelIndex];

			if (samples === undefined || samples.length < frameCount) {
				throw new Error(
					`TruePeakArgmaxAccumulator: channel ${channelIndex} has ${samples?.length ?? 0} samples, fewer than the requested ${frameCount}`,
				);
			}

			if (upsampler === undefined) {
				throw new Error(`TruePeakArgmaxAccumulator: missing upsampler for channel ${channelIndex}`);
			}

			const upsampledCount = upsampler.upsample(samples, frameCount, this.upsampleScratch);

			for (let index = 0; index < upsampledCount; index++) {
				const magnitude = Math.abs(this.upsampleScratch[index] ?? 0);

				if (magnitude > this.runningMax) {
					this.runningMax = magnitude;
					this.peakInputSample = this.inputBase + Math.floor(index / OVERSAMPLE_FACTOR);
				}
			}
		}

		this.inputBase += frameCount;
	}

	finalize(): { truePeakDb: number; peakInputSample: number } {
		if (this.finalized !== undefined) {
			return this.finalized;
		}

		if (this.upsampleScratch.length < FLUSH_OUTPUT_SAMPLES) {
			this.upsampleScratch = new Float64Array(FLUSH_OUTPUT_SAMPLES);
		}

		for (const upsampler of this.upsamplers) {
			const tailCount = upsampler.flush(this.upsampleScratch);

			for (let index = 0; index < tailCount; index++) {
				const magnitude = Math.abs(this.upsampleScratch[index] ?? 0);

				if (magnitude > this.runningMax) {
					this.runningMax = magnitude;
					this.peakInputSample = Math.max(0, this.inputBase - 1);
				}
			}
		}

		this.finalized = { truePeakDb: linearToDb(this.runningMax), peakInputSample: this.peakInputSample };

		return this.finalized;
	}
}
