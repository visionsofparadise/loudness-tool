import { TruePeakUpsampler } from "../../../measurement/TruePeakUpsampler";
import { OVERSAMPLE_FACTOR } from "./render";

const INITIAL_STRETCHES = 16;

export class StretchPeakMeter {
	private readonly stretchFrames: number;
	private readonly upsamplers: ReadonlyArray<TruePeakUpsampler>;
	private scratch = new Float64Array(0);
	private peaks = new Float64Array(INITIAL_STRETCHES);
	private framesPushed = 0;

	constructor(args: { stretchFrames: number; channelCount: number }) {
		const upsamplers: Array<TruePeakUpsampler> = [];

		for (let channelIndex = 0; channelIndex < args.channelCount; channelIndex++) {
			upsamplers.push(new TruePeakUpsampler());
		}

		this.stretchFrames = args.stretchFrames;
		this.upsamplers = upsamplers;
	}

	push(channels: ReadonlyArray<Float64Array>, frameCount: number): void {
		if (frameCount <= 0) {
			return;
		}

		const { stretchFrames } = this;
		const endFrame = this.framesPushed + frameCount;

		this.grow(Math.ceil(endFrame / stretchFrames));

		if (this.scratch.length < frameCount * OVERSAMPLE_FACTOR) {
			this.scratch = new Float64Array(frameCount * OVERSAMPLE_FACTOR);
		}

		const { peaks, scratch } = this;

		for (let channelIndex = 0; channelIndex < this.upsamplers.length; channelIndex++) {
			const channel = channels[channelIndex];
			const upsampler = this.upsamplers[channelIndex];

			if (channel === undefined || upsampler === undefined) {
				continue;
			}

			upsampler.upsample(channel, frameCount, scratch);

			for (let offset = 0; offset < frameCount; offset++) {
				const stretchIndex = Math.floor((this.framesPushed + offset) / stretchFrames);
				let peak = peaks[stretchIndex] ?? 0;

				for (let phase = 0; phase < OVERSAMPLE_FACTOR; phase++) {
					peak = Math.max(peak, Math.abs(scratch[offset * OVERSAMPLE_FACTOR + phase] ?? 0));
				}

				peaks[stretchIndex] = peak;
			}
		}

		this.framesPushed = endFrame;
	}

	finish(): Float64Array {
		return this.peaks.slice(0, Math.ceil(this.framesPushed / this.stretchFrames));
	}

	private grow(stretchCount: number): void {
		if (stretchCount <= this.peaks.length) {
			return;
		}

		const grown = new Float64Array(Math.max(stretchCount, this.peaks.length * 2));

		grown.set(this.peaks);
		this.peaks = grown;
	}
}
