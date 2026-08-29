import { TruePeakUpsampler } from "./TruePeakUpsampler";

const OVERSAMPLE_FACTOR = 4;
const FLUSH_OUTPUT_SAMPLES = 11 * OVERSAMPLE_FACTOR;

export class TruePeakAccumulator {
	private readonly channelCount: number;
	private readonly upsamplers: ReadonlyArray<TruePeakUpsampler>;
	private upsampleScratch: Float64Array = new Float64Array(0);
	private interpolatedMax = 0;
	private rawMax = 0;
	private finalizedResult: number | undefined;

	constructor(channelCount: number) {
		if (channelCount <= 0) {
			throw new Error(`TruePeakAccumulator: channelCount must be positive, got ${channelCount}`);
		}

		this.channelCount = channelCount;

		const upsamplers: Array<TruePeakUpsampler> = [];

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			upsamplers.push(new TruePeakUpsampler());
		}

		this.upsamplers = upsamplers;
	}

	push(channels: ReadonlyArray<Float64Array>, frameCount: number): void {
		if (this.finalizedResult !== undefined) {
			throw new Error("TruePeakAccumulator: push after finalize");
		}

		if (channels.length !== this.channelCount) {
			throw new Error(`TruePeakAccumulator: push got ${channels.length} channels, expected ${this.channelCount}`);
		}

		if (frameCount <= 0) {
			return;
		}

		for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex++) {
			const channel = channels[channelIndex];

			if (channel === undefined || channel.length < frameCount) {
				throw new Error(
					`TruePeakAccumulator: channel ${channelIndex} has ${channel?.length ?? 0} samples, fewer than the requested ${frameCount}`,
				);
			}

			const upsampler = this.upsamplers[channelIndex];

			if (upsampler === undefined) {
				throw new Error(`TruePeakAccumulator: missing upsampler for channel ${channelIndex}`);
			}

			for (let index = 0; index < frameCount; index++) {
				const sample = channel[index] ?? 0;
				const magnitude = sample < 0 ? -sample : sample;

				if (magnitude > this.rawMax) {
					this.rawMax = magnitude;
				}
			}

			const outputLength = frameCount * OVERSAMPLE_FACTOR;

			if (this.upsampleScratch.length < outputLength) {
				this.upsampleScratch = new Float64Array(outputLength);
			}

			const upsampledCount = upsampler.upsample(channel, frameCount, this.upsampleScratch);

			for (let index = 0; index < upsampledCount; index++) {
				const sample = this.upsampleScratch[index] ?? 0;
				const magnitude = sample < 0 ? -sample : sample;

				if (magnitude > this.interpolatedMax) {
					this.interpolatedMax = magnitude;
				}
			}
		}
	}

	finalize(): number {
		if (this.finalizedResult !== undefined) {
			return this.finalizedResult;
		}

		for (const upsampler of this.upsamplers) {
			if (this.upsampleScratch.length < FLUSH_OUTPUT_SAMPLES) {
				this.upsampleScratch = new Float64Array(FLUSH_OUTPUT_SAMPLES);
			}

			const tailCount = upsampler.flush(this.upsampleScratch);

			for (let index = 0; index < tailCount; index++) {
				const sample = this.upsampleScratch[index] ?? 0;
				const magnitude = sample < 0 ? -sample : sample;

				if (magnitude > this.interpolatedMax) {
					this.interpolatedMax = magnitude;
				}
			}
		}

		this.finalizedResult = Math.max(this.rawMax, this.interpolatedMax);

		return this.finalizedResult;
	}
}
