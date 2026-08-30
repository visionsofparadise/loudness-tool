import { Fft, hannWindow } from "../../../utils/Fft";
import { isBindingPeak, peakPriorityAmount } from "./binding";
import { designDispersionAllpass, schroederTargetToDelay } from "./dispersion";
import { LATTICE_ORDER, stepDownToReflection } from "./lattice";
import { measureFrameTruePeakDb } from "./objective";
import { searchBindingPeak } from "./search";
import type { ControlTrajectory } from "./trajectory";

const TRANSIENT_ENERGY_RATIO = 2.0;

export interface LatticeAnalysisSource {
	readonly channelCount: number;
	readonly signalLength: number;
	blocks(): AsyncIterable<ReadonlyArray<Float64Array>>;
}

export interface ItemSevenSearchParams {
	readonly globalTruePeakDb: number;
	readonly peakInputSample: number;
	readonly sampleRate: number;
	readonly lambda: number;
}

export const hopSizeOf = (frameSize: number): number => Math.floor(frameSize / 4);

export const stftFrameCount = (signalLength: number, frameSize: number, hopSize: number): number => {
	if (signalLength < frameSize || hopSize <= 0) {
		return 0;
	}

	return Math.floor((signalLength - frameSize) / hopSize) + 1;
};

const fitReflectionRow = (magnitude: Float64Array, amount: number, order: number): Float64Array => {
	const delay = schroederTargetToDelay(magnitude, amount);
	const { denominator } = designDispersionAllpass(delay, order);
	const reflection = stepDownToReflection(denominator);
	const row = new Float64Array(order);

	for (let section = 0; section < order; section++) {
		row[section] = reflection[section] ?? 0;
	}

	return row;
};

const fillMagnitude = (
	sumWindow: Float64Array,
	window: Float64Array,
	fft: Fft,
	real: Float64Array,
	imaginary: Float64Array,
	magnitude: Float64Array,
): number => {
	const frameSize = sumWindow.length;

	for (let index = 0; index < frameSize; index++) {
		real[index] = (sumWindow[index] ?? 0) * (window[index] ?? 0);
		imaginary[index] = 0;
	}

	fft.forward(real, imaginary);

	let energy = 0;

	for (let bin = 0; bin < magnitude.length; bin++) {
		const mag = Math.hypot(real[bin] ?? 0, imaginary[bin] ?? 0);

		magnitude[bin] = mag;
		energy += mag * mag;
	}

	return energy;
};

export const streamLatticeTrajectory = async (
	source: LatticeAnalysisSource,
	frameSize: number,
	hopSize: number,
	search: ItemSevenSearchParams,
): Promise<{
	trajectory: ControlTrajectory;
	frameCount: number;
	signalLength: number;
	bindingMask: Array<boolean>;
}> => {
	const channelCount = source.channelCount;
	const signalLength = source.signalLength;
	const order = LATTICE_ORDER;
	const halfSize = frameSize / 2 + 1;
	const frameCount = stftFrameCount(signalLength, frameSize, hopSize);
	const identity = new Float64Array(order);
	const baseRows = new Array<Float64Array>(frameCount);
	const amountEnv = new Float64Array(frameCount);
	const transientMask = new Float64Array(frameCount);
	const peakSampleIndex = new Int32Array(frameCount);
	const trajectory: ControlTrajectory = {
		rows: [],
		baseRows,
		amountEnv,
		laneCount: order,
		identity,
		transientMask,
		peakSampleIndex,
	};
	const bindingMask = new Array<boolean>(frameCount).fill(true);

	if (frameCount === 0 || channelCount === 0) {
		return { trajectory, frameCount, signalLength, bindingMask };
	}

	const globalTruePeakFrame = Math.min(frameCount - 1, Math.max(0, Math.round(search.peakInputSample / hopSize)));
	const fft = new Fft(frameSize);
	const analysisWindow = hannWindow(frameSize);
	const real = new Float64Array(frameSize);
	const imaginary = new Float64Array(frameSize);
	const sumRing = new Float64Array(frameSize);
	const channelRings: Array<Float64Array> = Array.from({ length: channelCount }, () => new Float64Array(frameSize));
	const sumWindow = new Float64Array(frameSize);
	const channelWindows: Array<Float64Array> = Array.from({ length: channelCount }, () => new Float64Array(frameSize));
	const sumMagnitude = new Float64Array(halfSize);
	let consumed = 0;
	let nextFrame = 0;
	let previousEnergy = 0;

	const takeFrame = (): void => {
		const start = nextFrame * hopSize;

		for (let pos = 0; pos < frameSize; pos++) {
			sumWindow[pos] = sumRing[(start + pos) % frameSize] ?? 0;
		}

		for (let channel = 0; channel < channelCount; channel++) {
			const channelRing = channelRings[channel];
			const channelWindow = channelWindows[channel];

			if (channelRing === undefined || channelWindow === undefined) {
				continue;
			}

			for (let pos = 0; pos < frameSize; pos++) {
				channelWindow[pos] = channelRing[(start + pos) % frameSize] ?? 0;
			}
		}

		const energy = fillMagnitude(sumWindow, analysisWindow, fft, real, imaginary, sumMagnitude);

		transientMask[nextFrame] = previousEnergy > 0 && energy > TRANSIENT_ENERGY_RATIO * previousEnergy ? 1 : 0;
		previousEnergy = energy;

		const amount = peakPriorityAmount(sumWindow, 0, frameSize);
		let windowPeak = 0;
		let peakPos = 0;

		for (let pos = 0; pos < frameSize; pos++) {
			const value = sumWindow[pos] ?? 0;
			const absolute = value < 0 ? -value : value;

			if (absolute > windowPeak) {
				windowPeak = absolute;
				peakPos = pos;
			}
		}

		peakSampleIndex[nextFrame] = start + peakPos;

		const row = fitReflectionRow(sumMagnitude, amount, order);

		baseRows[nextFrame] = row;

		const frameTruePeakDb = measureFrameTruePeakDb(channelWindows);
		const isGlobalTpFrame = globalTruePeakFrame === nextFrame;
		const bound = isBindingPeak(frameTruePeakDb, amount, search.globalTruePeakDb, isGlobalTpFrame);

		bindingMask[nextFrame] = bound;
		amountEnv[nextFrame] = bound ? searchBindingPeak(channelWindows, row, order, search.lambda).scale : 0;
		nextFrame += 1;
	};

	for await (const channels of source.blocks()) {
		const got = channels[0]?.length ?? 0;

		for (let index = 0; index < got; index++) {
			let sample = 0;
			const ringPos = consumed % frameSize;

			for (let channel = 0; channel < channelCount; channel++) {
				const value = channels[channel]?.[index] ?? 0;

				sample += value;

				const channelRing = channelRings[channel];

				if (channelRing !== undefined) {
					channelRing[ringPos] = value;
				}
			}

			sumRing[ringPos] = sample;
			consumed += 1;

			while (nextFrame < frameCount && consumed >= nextFrame * hopSize + frameSize) {
				takeFrame();
			}
		}
	}

	for (let frame = 0; frame < frameCount; frame++) {
		const wasReached = baseRows[frame] !== undefined;

		baseRows[frame] ??= new Float64Array(order);

		if (!wasReached) {
			amountEnv[frame] = 0;
			bindingMask[frame] = false;
		}
	}

	return { trajectory, frameCount, signalLength, bindingMask };
};
