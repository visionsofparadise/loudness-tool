import { preFilterCoefficients, rlbFilterCoefficients } from "./kWeighting";

// eslint-disable-next-line comment-rules/no-restricted-comments
// K-weighting filter cascade and channel summation follow ITU-R BS.1770-5.

export class KWeightedSquaredSum {
	private readonly channelCount: number;
	private readonly weights: Float64Array;

	private readonly preB0: number;
	private readonly preB1: number;
	private readonly preB2: number;
	private readonly preA1: number;
	private readonly preA2: number;
	private readonly rlbB0: number;
	private readonly rlbB1: number;
	private readonly rlbB2: number;
	private readonly rlbA1: number;
	private readonly rlbA2: number;

	private readonly preX1: Float64Array;
	private readonly preX2: Float64Array;
	private readonly preY1: Float64Array;
	private readonly preY2: Float64Array;
	private readonly rlbX1: Float64Array;
	private readonly rlbX2: Float64Array;
	private readonly rlbY1: Float64Array;
	private readonly rlbY2: Float64Array;

	constructor(sampleRate: number, weights: Float64Array) {
		const channelCount = weights.length;

		if (channelCount <= 0) {
			throw new Error(`KWeightedSquaredSum: channelCount must be positive, got ${channelCount}`);
		}

		this.channelCount = channelCount;
		this.weights = weights;

		const preFilter = preFilterCoefficients(sampleRate);
		const rlbFilter = rlbFilterCoefficients(sampleRate);

		this.preB0 = preFilter.b0;
		this.preB1 = preFilter.b1;
		this.preB2 = preFilter.b2;
		this.preA1 = preFilter.a1;
		this.preA2 = preFilter.a2;
		this.rlbB0 = rlbFilter.b0;
		this.rlbB1 = rlbFilter.b1;
		this.rlbB2 = rlbFilter.b2;
		this.rlbA1 = rlbFilter.a1;
		this.rlbA2 = rlbFilter.a2;

		this.preX1 = new Float64Array(channelCount);
		this.preX2 = new Float64Array(channelCount);
		this.preY1 = new Float64Array(channelCount);
		this.preY2 = new Float64Array(channelCount);
		this.rlbX1 = new Float64Array(channelCount);
		this.rlbX2 = new Float64Array(channelCount);
		this.rlbY1 = new Float64Array(channelCount);
		this.rlbY2 = new Float64Array(channelCount);
	}

	push(channels: ReadonlyArray<Float64Array>, frameCount: number, output: Float64Array): void {
		if (frameCount <= 0) {
			return;
		}

		if (output.length < frameCount) {
			throw new Error(
				`KWeightedSquaredSum: output buffer has ${output.length} entries, fewer than the requested ${frameCount}`,
			);
		}

		if (channels.length !== this.channelCount) {
			throw new Error(`KWeightedSquaredSum: push got ${channels.length} channels, expected ${this.channelCount}`);
		}

		for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex++) {
			if ((channels[channelIndex]?.length ?? 0) < frameCount) {
				throw new Error(
					`KWeightedSquaredSum: channel ${channelIndex} has ${channels[channelIndex]?.length ?? 0} samples, fewer than the requested ${frameCount}`,
				);
			}
		}

		const channelCount = this.channelCount;
		const preB0 = this.preB0;
		const preB1 = this.preB1;
		const preB2 = this.preB2;
		const preA1 = this.preA1;
		const preA2 = this.preA2;
		const rlbB0 = this.rlbB0;
		const rlbB1 = this.rlbB1;
		const rlbB2 = this.rlbB2;
		const rlbA1 = this.rlbA1;
		const rlbA2 = this.rlbA2;

		output.fill(-0, 0, frameCount);

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			const weight = this.weights[channelIndex] ?? 1;

			if (weight === 0) {
				continue;
			}

			const channel = channels[channelIndex] ?? channels[0] ?? new Float64Array(0);
			let preX1 = this.preX1[channelIndex] ?? 0;
			let preX2 = this.preX2[channelIndex] ?? 0;
			let preY1 = this.preY1[channelIndex] ?? 0;
			let preY2 = this.preY2[channelIndex] ?? 0;
			let rlbX1 = this.rlbX1[channelIndex] ?? 0;
			let rlbX2 = this.rlbX2[channelIndex] ?? 0;
			let rlbY1 = this.rlbY1[channelIndex] ?? 0;
			let rlbY2 = this.rlbY2[channelIndex] ?? 0;

			for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
				const x0 = channel[frameIndex] ?? 0;
				const preY = preB0 * x0 + preB1 * preX1 + preB2 * preX2 - preA1 * preY1 - preA2 * preY2;

				preX2 = preX1;
				preX1 = x0;
				preY2 = preY1;
				preY1 = preY;

				const rlbY = rlbB0 * preY + rlbB1 * rlbX1 + rlbB2 * rlbX2 - rlbA1 * rlbY1 - rlbA2 * rlbY2;

				rlbX2 = rlbX1;
				rlbX1 = preY;
				rlbY2 = rlbY1;
				rlbY1 = rlbY;

				output[frameIndex] = (output[frameIndex] ?? 0) + rlbY * rlbY * weight;
			}

			this.preX1[channelIndex] = preX1;
			this.preX2[channelIndex] = preX2;
			this.preY1[channelIndex] = preY1;
			this.preY2[channelIndex] = preY2;
			this.rlbX1[channelIndex] = rlbX1;
			this.rlbX2[channelIndex] = rlbX2;
			this.rlbY1[channelIndex] = rlbY1;
			this.rlbY2[channelIndex] = rlbY2;
		}
	}
}
