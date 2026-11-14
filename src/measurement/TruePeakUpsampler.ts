import { GuardedUpsampler } from "./GuardedUpsampler";

const HALF_BAND_PHASE_TAPS = 160;
const HALF_BAND_BETA = 5;
const HALF_BAND_FOLDED_TAPS = HALF_BAND_PHASE_TAPS / 2;
const HALF_BAND_HISTORY = HALF_BAND_PHASE_TAPS - 1;
const HALF_BAND_DELAY = HALF_BAND_PHASE_TAPS / 2;

const INTERPOLATOR_FACTOR = 8;
const INTERPOLATOR_PHASE_TAPS = 8;
const INTERPOLATOR_BETA = 6;
const INTERPOLATOR_LENGTH = INTERPOLATOR_FACTOR * INTERPOLATOR_PHASE_TAPS;
const INTERPOLATOR_HISTORY = INTERPOLATOR_PHASE_TAPS - 1;
const INTERPOLATOR_DELAY = INTERPOLATOR_PHASE_TAPS / 2;

export const UPSAMPLE_FACTOR = 2 * INTERPOLATOR_FACTOR;

export const DELAY_FRAMES = HALF_BAND_DELAY + INTERPOLATOR_DELAY / 2;

export const FLUSH_FRAMES = DELAY_FRAMES * 2 - 1;

export const alignedFrameOf = (framesBefore: number, upsampledIndex: number, lastFrame: number): number =>
	Math.min(lastFrame, Math.max(0, framesBefore + Math.floor(upsampledIndex / UPSAMPLE_FACTOR) - DELAY_FRAMES));

const besselI0 = (x: number): number => {
	const quarterSquare = (x * x) / 4;
	let term = 1;
	let sum = 1;

	for (let order = 1; term > sum * 1e-18; order++) {
		term *= quarterSquare / (order * order);
		sum += term;
	}

	return sum;
};

const kaiserAt = (index: number, length: number, beta: number): number => {
	const centre = (length - 1) / 2;
	const offset = (index - centre) / centre;

	return besselI0(beta * Math.sqrt(1 - offset * offset)) / besselI0(beta);
};

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

export const HALF_BAND_TAPS = Float64Array.from({ length: HALF_BAND_PHASE_TAPS }, (_, tap) => {
	const index = 2 * tap + 1;

	return sinc((index - HALF_BAND_PHASE_TAPS) / 2) * kaiserAt(index, 2 * HALF_BAND_PHASE_TAPS + 1, HALF_BAND_BETA);
});

export const INTERPOLATOR_TAPS = Float64Array.from(
	{ length: INTERPOLATOR_LENGTH },
	(_, index) =>
		sinc((index - INTERPOLATOR_LENGTH / 2) / INTERPOLATOR_FACTOR) *
		kaiserAt(index, INTERPOLATOR_LENGTH + 1, INTERPOLATOR_BETA),
);

const FOLDED_TAPS = HALF_BAND_TAPS.slice(0, HALF_BAND_FOLDED_TAPS);

const PHASE_TAPS = Float64Array.from({ length: INTERPOLATOR_LENGTH }, (_, index) => {
	const phase = Math.floor(index / INTERPOLATOR_PHASE_TAPS);
	const tap = index % INTERPOLATOR_PHASE_TAPS;

	return INTERPOLATOR_TAPS[tap * INTERPOLATOR_FACTOR + phase] ?? 0;
});

export class TruePeakUpsampler extends GuardedUpsampler {
	private readonly inputHistory = new Float64Array(HALF_BAND_HISTORY);
	private readonly halfBandHistory = new Float64Array(INTERPOLATOR_HISTORY);
	private inputWork: Float64Array = new Float64Array(0);
	private halfBandWork: Float64Array = new Float64Array(0);

	constructor() {
		super("TruePeakUpsampler", UPSAMPLE_FACTOR, FLUSH_FRAMES);
	}

	protected clear(): void {
		this.inputHistory.fill(0);
		this.halfBandHistory.fill(0);
		this.inputWork = new Float64Array(0);
		this.halfBandWork = new Float64Array(0);
	}

	protected process(input: Float64Array, frameCount: number, output: Float64Array): void {
		const halfBandCount = 2 * frameCount;
		const inputWork = this.workOf("inputWork", HALF_BAND_HISTORY + frameCount);
		const halfBandWork = this.workOf("halfBandWork", INTERPOLATOR_HISTORY + halfBandCount);

		inputWork.set(this.inputHistory, 0);
		inputWork.set(input.subarray(0, frameCount), HALF_BAND_HISTORY);
		halfBandWork.set(this.halfBandHistory, 0);

		for (let inputIndex = 0; inputIndex < frameCount; inputIndex++) {
			const newest = HALF_BAND_HISTORY + inputIndex;
			const oldest = newest - HALF_BAND_HISTORY;
			let odd = 0;

			for (let tap = 0; tap < HALF_BAND_FOLDED_TAPS; tap++) {
				odd += (FOLDED_TAPS[tap] ?? 0) * ((inputWork[newest - tap] ?? 0) + (inputWork[oldest + tap] ?? 0));
			}

			const halfBandIndex = INTERPOLATOR_HISTORY + 2 * inputIndex;

			halfBandWork[halfBandIndex] = inputWork[newest - HALF_BAND_DELAY] ?? 0;
			halfBandWork[halfBandIndex + 1] = odd;
		}

		for (let halfBandIndex = 0; halfBandIndex < halfBandCount; halfBandIndex++) {
			const newest = INTERPOLATOR_HISTORY + halfBandIndex;
			const outputOffset = halfBandIndex * INTERPOLATOR_FACTOR;
			const value0 = halfBandWork[newest] ?? 0;
			const value1 = halfBandWork[newest - 1] ?? 0;
			const value2 = halfBandWork[newest - 2] ?? 0;
			const value3 = halfBandWork[newest - 3] ?? 0;
			const value4 = halfBandWork[newest - 4] ?? 0;
			const value5 = halfBandWork[newest - 5] ?? 0;
			const value6 = halfBandWork[newest - 6] ?? 0;
			const value7 = halfBandWork[newest - 7] ?? 0;

			output[outputOffset] = value4;

			for (let phase = 1; phase < INTERPOLATOR_FACTOR; phase++) {
				const base = phase * INTERPOLATOR_PHASE_TAPS;

				output[outputOffset + phase] =
					(PHASE_TAPS[base] ?? 0) * value0 +
					(PHASE_TAPS[base + 1] ?? 0) * value1 +
					(PHASE_TAPS[base + 2] ?? 0) * value2 +
					(PHASE_TAPS[base + 3] ?? 0) * value3 +
					(PHASE_TAPS[base + 4] ?? 0) * value4 +
					(PHASE_TAPS[base + 5] ?? 0) * value5 +
					(PHASE_TAPS[base + 6] ?? 0) * value6 +
					(PHASE_TAPS[base + 7] ?? 0) * value7;
			}
		}

		this.inputHistory.set(inputWork.subarray(frameCount, frameCount + HALF_BAND_HISTORY));
		this.halfBandHistory.set(halfBandWork.subarray(halfBandCount, halfBandCount + INTERPOLATOR_HISTORY));
	}

	private workOf(key: "inputWork" | "halfBandWork", length: number): Float64Array {
		if (this[key].length < length) {
			this[key] = new Float64Array(length);
		}

		return this[key];
	}
}
