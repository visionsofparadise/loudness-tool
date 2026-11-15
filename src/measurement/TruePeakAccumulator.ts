import { MeasurementOverflow } from "./MeasurementOverflow";
import {
	alignedFrameOf,
	DEFAULT_OVERSAMPLING,
	FLUSH_FRAMES,
	TruePeakUpsampler,
	type OversamplingFactor,
} from "./TruePeakUpsampler";

export class TruePeakAccumulator {
	private readonly channelCount: number;
	private readonly factor: OversamplingFactor;
	private readonly upsamplers: ReadonlyArray<TruePeakUpsampler>;
	private upsampleScratch: Float64Array = new Float64Array(0);
	private interpolatedMax = 0;
	private rawMax = 0;
	private framesPushed = 0;
	private finalizedResult: number | undefined;

	constructor(channelCount: number, factor: OversamplingFactor = DEFAULT_OVERSAMPLING) {
		if (channelCount <= 0) {
			throw new Error(`TruePeakAccumulator: channelCount must be positive, got ${channelCount}`);
		}

		this.channelCount = channelCount;
		this.factor = factor;

		const upsamplers: Array<TruePeakUpsampler> = [];

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			upsamplers.push(new TruePeakUpsampler(factor));
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

			const outputLength = frameCount * this.factor;

			if (this.upsampleScratch.length < outputLength) {
				this.upsampleScratch = new Float64Array(outputLength);
			}

			const upsampledCount = upsampler.upsample(channel, frameCount, this.upsampleScratch);

			this.trackInterpolated(upsampledCount, frameCount - 1);
		}

		this.framesPushed += frameCount;
	}

	finalize(): number {
		if (this.finalizedResult !== undefined) {
			return this.finalizedResult;
		}

		const flushOutputSamples = FLUSH_FRAMES * this.factor;

		for (const upsampler of this.upsamplers) {
			if (this.upsampleScratch.length < flushOutputSamples) {
				this.upsampleScratch = new Float64Array(flushOutputSamples);
			}

			this.trackInterpolated(upsampler.flush(this.upsampleScratch), -1);
		}

		this.finalizedResult = Math.max(this.rawMax, this.interpolatedMax);

		return this.finalizedResult;
	}

	private trackInterpolated(count: number, lastFrameOffset: number): void {
		for (let index = 0; index < count; index++) {
			const sample = this.upsampleScratch[index] ?? 0;
			const magnitude = sample < 0 ? -sample : sample;

			if (!(magnitude <= this.interpolatedMax)) {
				if (!(magnitude < Number.POSITIVE_INFINITY)) {
					throw new MeasurementOverflow(
						alignedFrameOf(this.framesPushed, index, this.framesPushed + lastFrameOffset, this.factor),
					);
				}

				this.interpolatedMax = magnitude;
			}
		}
	}
}
