import { chargeOf, windowPositionsOf } from "./charge";
import {
	allocateChannels,
	measureStretch,
	OVERSAMPLE_FACTOR,
	TRUE_PEAK_TAIL_FRAMES,
	type StretchMeasure,
} from "./render";
import { printedDbOf, quantizerOf } from "./rounding";
import type { WavBitDepth } from "../../../wav/utils/wavFormat";

interface HeldStretch {
	readonly measure: StretchMeasure;
	readonly frameCount: number;
}

export class SourceMeter {
	private readonly stretchFrames: number;
	private readonly quantize: (sample: number) => number;
	private readonly stride: number;
	private readonly frames: ReadonlyArray<Float64Array>;
	private readonly scratch: Float64Array;
	private readonly tailScratch: Float64Array;
	private readonly values: Float64Array;
	private readings = new Float64Array(16);
	private readingCount = 0;
	private filledFrames = 0;
	private held: HeldStretch | undefined;
	private previousMeasure: StretchMeasure | undefined;

	constructor(args: { stretchFrames: number; channelCount: number; bitDepth: WavBitDepth }) {
		this.stretchFrames = args.stretchFrames;
		this.quantize = quantizerOf(args.bitDepth);
		this.stride = OVERSAMPLE_FACTOR * args.channelCount;
		this.frames = allocateChannels(args.channelCount, args.stretchFrames);
		this.scratch = new Float64Array(args.stretchFrames * OVERSAMPLE_FACTOR);
		this.tailScratch = new Float64Array(TRUE_PEAK_TAIL_FRAMES * OVERSAMPLE_FACTOR);
		this.values = new Float64Array(this.stride);
	}

	push(channels: ReadonlyArray<Float64Array>, frameCount: number): void {
		let offset = 0;

		while (offset < frameCount) {
			if (this.held !== undefined) {
				this.chargeHeld(false);
			}

			const take = Math.min(this.stretchFrames - this.filledFrames, frameCount - offset);

			for (let channelIndex = 0; channelIndex < this.frames.length; channelIndex++) {
				const target = this.frames[channelIndex];
				const source = channels[channelIndex];

				if (target === undefined || source === undefined) {
					continue;
				}

				for (let index = 0; index < take; index++) {
					target[this.filledFrames + index] = this.quantize(source[offset + index] ?? 0);
				}
			}

			this.filledFrames += take;
			offset += take;

			if (this.filledFrames === this.stretchFrames) {
				this.measureFilled();
			}
		}
	}

	finish(): Float64Array {
		if (this.filledFrames > 0) {
			this.measureFilled();
		}

		if (this.held !== undefined) {
			this.chargeHeld(true);
		}

		return this.readings.slice(0, this.readingCount);
	}

	private measureFilled(): void {
		this.held = {
			measure: measureStretch({
				output: this.frames,
				sourceFrames: this.frames,
				frameCount: this.filledFrames,
				scratch: this.scratch,
				tailScratch: this.tailScratch,
			}),
			frameCount: this.filledFrames,
		};
		this.filledFrames = 0;
	}

	private chargeHeld(isLast: boolean): void {
		const held = this.held;

		if (held === undefined) {
			return;
		}

		const firstFrame = this.readingCount * this.stretchFrames;
		const charge = chargeOf({
			measure: held.measure,
			previousMeasure: this.previousMeasure,
			firstFrame,
			endFrame: firstFrame + held.frameCount - 1,
			stretchFrames: this.stretchFrames,
			positions: windowPositionsOf(firstFrame, held.frameCount, isLast),
			values: this.values,
			stride: this.stride,
		});

		if (this.readingCount === this.readings.length) {
			const grown = new Float64Array(this.readings.length * 2);

			grown.set(this.readings);
			this.readings = grown;
		}

		this.readings[this.readingCount] = printedDbOf(charge);
		this.readingCount += 1;
		this.previousMeasure = held.measure;
		this.held = undefined;
	}
}
