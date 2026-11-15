import { GuardedUpsampler } from "./GuardedUpsampler";

const HALF_BAND_PHASE_TAPS = 160;
const HALF_BAND_BETA = 5;
const HALF_BAND_FOLDED_TAPS = HALF_BAND_PHASE_TAPS / 2;
const HALF_BAND_HISTORY = HALF_BAND_PHASE_TAPS - 1;
const HALF_BAND_DELAY = HALF_BAND_PHASE_TAPS / 2;

const INTERPOLATOR_PHASE_TAPS = 8;
const INTERPOLATOR_BETA = 6;
const INTERPOLATOR_HISTORY = INTERPOLATOR_PHASE_TAPS - 1;
const INTERPOLATOR_DELAY = INTERPOLATOR_PHASE_TAPS / 2;

export const OVERSAMPLING_FACTORS = [8, 16] as const;

export type OversamplingFactor = (typeof OVERSAMPLING_FACTORS)[number];

export const DEFAULT_OVERSAMPLING: OversamplingFactor = 8;

export const DELAY_FRAMES = HALF_BAND_DELAY + INTERPOLATOR_DELAY / 2;

export const FLUSH_FRAMES = DELAY_FRAMES * 2 - 1;

export const alignedFrameOf = (
	framesBefore: number,
	upsampledIndex: number,
	lastFrame: number,
	factor: OversamplingFactor,
): number => Math.min(lastFrame, Math.max(0, framesBefore + Math.floor(upsampledIndex / factor) - DELAY_FRAMES));

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

export const interpolatorTapsOf = (interpolatorFactor: number): Float64Array => {
	const length = interpolatorFactor * INTERPOLATOR_PHASE_TAPS;

	return Float64Array.from(
		{ length },
		(_, index) => sinc((index - length / 2) / interpolatorFactor) * kaiserAt(index, length + 1, INTERPOLATOR_BETA),
	);
};

const FOLDED_TAPS = HALF_BAND_TAPS.slice(0, HALF_BAND_FOLDED_TAPS);

const phaseTapsOf = (interpolatorFactor: number): Float64Array => {
	const taps = interpolatorTapsOf(interpolatorFactor);

	return Float64Array.from({ length: taps.length }, (_, index) => {
		const phase = Math.floor(index / INTERPOLATOR_PHASE_TAPS);
		const tap = index % INTERPOLATOR_PHASE_TAPS;

		return taps[tap * interpolatorFactor + phase] ?? 0;
	});
};

const PHASE_TAPS_BY_FACTOR: Readonly<Record<OversamplingFactor, Float64Array>> = {
	8: phaseTapsOf(4),
	16: phaseTapsOf(8),
};

export class TruePeakUpsampler extends GuardedUpsampler {
	private readonly inputHistory = new Float64Array(HALF_BAND_HISTORY);
	private readonly halfBandHistory = new Float64Array(INTERPOLATOR_HISTORY);
	private inputWork: Float64Array = new Float64Array(0);
	private halfBandWork: Float64Array = new Float64Array(0);
	private readonly interpolatorFactor: number;
	private readonly phaseTaps: Float64Array;

	constructor(factor: OversamplingFactor = DEFAULT_OVERSAMPLING) {
		super("TruePeakUpsampler", factor, FLUSH_FRAMES);
		this.interpolatorFactor = factor / 2;
		this.phaseTaps = PHASE_TAPS_BY_FACTOR[factor];
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

		const { interpolatorFactor, phaseTaps } = this;

		for (let halfBandIndex = 0; halfBandIndex < halfBandCount; halfBandIndex++) {
			const newest = INTERPOLATOR_HISTORY + halfBandIndex;
			const outputOffset = halfBandIndex * interpolatorFactor;
			const value0 = halfBandWork[newest] ?? 0;
			const value1 = halfBandWork[newest - 1] ?? 0;
			const value2 = halfBandWork[newest - 2] ?? 0;
			const value3 = halfBandWork[newest - 3] ?? 0;
			const value4 = halfBandWork[newest - 4] ?? 0;
			const value5 = halfBandWork[newest - 5] ?? 0;
			const value6 = halfBandWork[newest - 6] ?? 0;
			const value7 = halfBandWork[newest - 7] ?? 0;

			output[outputOffset] = value4;

			for (let phase = 1; phase < interpolatorFactor; phase++) {
				const base = phase * INTERPOLATOR_PHASE_TAPS;

				output[outputOffset + phase] =
					(phaseTaps[base] ?? 0) * value0 +
					(phaseTaps[base + 1] ?? 0) * value1 +
					(phaseTaps[base + 2] ?? 0) * value2 +
					(phaseTaps[base + 3] ?? 0) * value3 +
					(phaseTaps[base + 4] ?? 0) * value4 +
					(phaseTaps[base + 5] ?? 0) * value5 +
					(phaseTaps[base + 6] ?? 0) * value6 +
					(phaseTaps[base + 7] ?? 0) * value7;
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
