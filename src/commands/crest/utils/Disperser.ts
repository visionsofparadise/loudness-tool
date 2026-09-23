import { Fft, nextPowerOfTwo } from "../../../utils/Fft";
import { dispersionKernelOf } from "./dispersion";

const BLOCK_KERNEL_RATIO = 4;
const SMALLEST_BLOCK_SIZE = 256;

export class Disperser {
	static of(steps: ReadonlyArray<number>, maxStepFrames: number): Disperser {
		const kernelFrames = 2 * maxStepFrames + 1;
		const size = nextPowerOfTwo(Math.max(SMALLEST_BLOCK_SIZE, BLOCK_KERNEL_RATIO * kernelFrames));

		return new Disperser(steps, maxStepFrames, new Fft(size));
	}

	readonly hopFrames: number;

	private readonly steps: ReadonlyArray<number>;
	private readonly maxStepFrames: number;
	private readonly fft: Fft;
	private readonly kernelReal: Array<Float64Array>;
	private readonly kernelImaginary: Array<Float64Array>;
	private readonly blockReal: Float64Array;
	private readonly blockImaginary: Float64Array;
	private readonly productReal: Float64Array;
	private readonly productImaginary: Float64Array;

	private constructor(steps: ReadonlyArray<number>, maxStepFrames: number, fft: Fft) {
		const kernelReal: Array<Float64Array> = [];
		const kernelImaginary: Array<Float64Array> = [];

		for (const step of steps) {
			const real = new Float64Array(fft.size);
			const imaginary = new Float64Array(fft.size);

			real.set(dispersionKernelOf(step), 0);
			fft.forward(real, imaginary);
			kernelReal.push(real);
			kernelImaginary.push(imaginary);
		}

		this.steps = steps;
		this.maxStepFrames = maxStepFrames;
		this.fft = fft;
		this.hopFrames = fft.size - 2 * maxStepFrames;
		this.kernelReal = kernelReal;
		this.kernelImaginary = kernelImaginary;
		this.blockReal = new Float64Array(fft.size);
		this.blockImaginary = new Float64Array(fft.size);
		this.productReal = new Float64Array(fft.size);
		this.productImaginary = new Float64Array(fft.size);
	}

	disperse(args: {
		window: ReadonlyArray<Float64Array>;
		windowFirstFrame: number;
		firstFrame: number;
		frameCount: number;
		stepIndices: ReadonlyArray<number>;
		targets: ReadonlyArray<ReadonlyArray<Float64Array>>;
	}): void {
		const { window, windowFirstFrame, firstFrame, frameCount, stepIndices, targets } = args;
		const moving = stepIndices.filter((stepIndex) => (this.steps[stepIndex] ?? 0) !== 0);
		const held = stepIndices.filter((stepIndex) => (this.steps[stepIndex] ?? 0) === 0);

		for (let blockFirst = firstFrame; blockFirst < firstFrame + frameCount; blockFirst += this.hopFrames) {
			const blockFrames = Math.min(this.hopFrames, firstFrame + frameCount - blockFirst);
			const targetFirst = blockFirst - firstFrame;

			for (let channelIndex = 0; channelIndex < window.length; channelIndex++) {
				const channel = window[channelIndex] ?? new Float64Array(0);
				const source = channel.subarray(blockFirst - windowFirstFrame, blockFirst - windowFirstFrame + blockFrames);

				for (const stepIndex of held) {
					targets[stepIndex]?.[channelIndex]?.set(source, targetFirst);
				}

				if (moving.length === 0) {
					continue;
				}

				this.loadBlock(channel, blockFirst - this.maxStepFrames - windowFirstFrame);

				for (const stepIndex of moving) {
					const target = targets[stepIndex]?.[channelIndex];

					if (target === undefined) {
						continue;
					}

					const readFirst = this.maxStepFrames + Math.abs(this.steps[stepIndex] ?? 0);

					this.multiplyBlock(stepIndex);
					this.fft.inverse(this.productReal, this.productImaginary);

					for (let offset = 0; offset < blockFrames; offset++) {
						target[targetFirst + offset] = this.productReal[readFirst + offset] ?? 0;
					}
				}
			}
		}
	}

	private loadBlock(channel: Float64Array, windowOffset: number): void {
		const { blockReal, blockImaginary, fft } = this;

		blockImaginary.fill(0);

		for (let index = 0; index < fft.size; index++) {
			blockReal[index] = channel[windowOffset + index] ?? 0;
		}

		fft.forward(blockReal, blockImaginary);
	}

	private multiplyBlock(stepIndex: number): void {
		const { blockReal, blockImaginary, productReal, productImaginary, fft } = this;
		const real = this.kernelReal[stepIndex] ?? productReal;
		const imaginary = this.kernelImaginary[stepIndex] ?? productImaginary;

		for (let index = 0; index < fft.size; index++) {
			const blockRealValue = blockReal[index] ?? 0;
			const blockImaginaryValue = blockImaginary[index] ?? 0;
			const kernelRealValue = real[index] ?? 0;
			const kernelImaginaryValue = imaginary[index] ?? 0;

			productReal[index] = blockRealValue * kernelRealValue - blockImaginaryValue * kernelImaginaryValue;
			productImaginary[index] = blockRealValue * kernelImaginaryValue + blockImaginaryValue * kernelRealValue;
		}
	}
}
