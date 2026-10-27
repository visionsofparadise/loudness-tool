import { FLUSH_FRAMES, TruePeakUpsampler } from "../../../measurement/TruePeakUpsampler";
import { FLOOR, PAIR_COUNT, WEIGHT_STATES, pairIndexOf, weightBetween } from "./blend";
import { WEIGHT_LEVELS } from "./layout";
import { OVERSAMPLE_FACTOR } from "./render";

const BISECTION_ROUNDS = 60;

export const upsampledOf = (samples: Float64Array): Float64Array => {
	const upsampler = new TruePeakUpsampler();
	const upsampled = new Float64Array((samples.length + FLUSH_FRAMES) * OVERSAMPLE_FACTOR);
	const written = upsampler.upsample(samples, samples.length, upsampled);

	upsampler.flush(upsampled.subarray(written));

	return upsampled;
};

export const stretchPeaksOf = (
	upsampled: ReadonlyArray<Float64Array>,
	frameCount: number,
	stretchFrames: number,
): Float64Array => {
	const stretchCount = Math.ceil(frameCount / stretchFrames);
	const peaks = new Float64Array(stretchCount);

	for (const channel of upsampled) {
		for (let index = 0; stretchCount > 0 && index < (frameCount + FLUSH_FRAMES) * OVERSAMPLE_FACTOR; index++) {
			const stretchIndex = Math.min(stretchCount - 1, Math.floor(index / OVERSAMPLE_FACTOR / stretchFrames));

			peaks[stretchIndex] = Math.max(peaks[stretchIndex] ?? 0, Math.abs(channel[index] ?? 0));
		}
	}

	return peaks;
};

const gentlestPathOf = (costs: ReadonlyArray<Float64Array>, level: number): Int32Array | undefined => {
	const stretchCount = costs.length;
	const isAllowed = (stretchIndex: number, from: number, to: number): boolean =>
		(costs[stretchIndex]?.[pairIndexOf(from, to)] ?? Infinity) <= level;
	const reachable = new Uint8Array((stretchCount + 1) * WEIGHT_STATES);

	reachable.fill(1, stretchCount * WEIGHT_STATES);

	for (let stretchIndex = stretchCount - 1; stretchIndex >= 0; stretchIndex--) {
		for (let from = 0; from < WEIGHT_STATES; from++) {
			for (let to = Math.max(0, from - 1); to <= Math.min(WEIGHT_LEVELS, from + 1); to++) {
				if (reachable[(stretchIndex + 1) * WEIGHT_STATES + to] === 1 && isAllowed(stretchIndex, from, to)) {
					reachable[stretchIndex * WEIGHT_STATES + from] = 1;

					break;
				}
			}
		}
	}

	const first = reachable.subarray(0, WEIGHT_STATES).indexOf(1);

	if (first < 0) {
		return undefined;
	}

	const path = new Int32Array(stretchCount + 1);

	path[0] = first;

	for (let stretchIndex = 0; stretchIndex < stretchCount; stretchIndex++) {
		const from = path[stretchIndex] ?? 0;

		for (let to = Math.max(0, from - 1); to <= Math.min(WEIGHT_LEVELS, from + 1); to++) {
			if (reachable[(stretchIndex + 1) * WEIGHT_STATES + to] === 1 && isAllowed(stretchIndex, from, to)) {
				path[stretchIndex + 1] = to;

				break;
			}
		}
	}

	return path;
};

export const oracleOf = (args: {
	current: ReadonlyArray<Float64Array>;
	dispersed: ReadonlyArray<Float64Array>;
	frameCount: number;
	stretchFrames: number;
}): { readonly costs: ReadonlyArray<Float64Array>; readonly level: number; readonly path: Int32Array } => {
	const { current, dispersed, frameCount, stretchFrames } = args;
	const stretchCount = Math.ceil(frameCount / stretchFrames);
	let peak = 0;

	for (const channel of current) {
		for (let index = 0; index < (frameCount + FLUSH_FRAMES) * OVERSAMPLE_FACTOR; index++) {
			peak = Math.max(peak, Math.abs(channel[index] ?? 0));
		}
	}

	const threshold = FLOOR * peak;
	const costs: Array<Float64Array> = [];

	for (let stretchIndex = 0; stretchIndex < stretchCount; stretchIndex++) {
		const firstFrame = stretchIndex * stretchFrames;
		const endFrame = Math.min(frameCount, firstFrame + stretchFrames);
		const endIndex = (stretchIndex === stretchCount - 1 ? endFrame + FLUSH_FRAMES : endFrame) * OVERSAMPLE_FACTOR;
		const table = new Float64Array(PAIR_COUNT);

		for (let channelIndex = 0; channelIndex < current.length; channelIndex++) {
			const currentChannel = current[channelIndex] ?? new Float64Array(0);
			const dispersedChannel = dispersed[channelIndex] ?? new Float64Array(0);

			for (let index = firstFrame * OVERSAMPLE_FACTOR; index < endIndex; index++) {
				const alpha = currentChannel[index] ?? 0;
				const dispersedValue = dispersedChannel[index] ?? 0;

				if (Math.max(Math.abs(alpha), Math.abs(dispersedValue)) <= threshold) {
					continue;
				}

				const beta = dispersedValue - alpha;
				const tau =
					(Math.min(Math.floor(index / OVERSAMPLE_FACTOR), endFrame - 1) - firstFrame + 1) / stretchFrames;

				for (let from = 0; from < WEIGHT_STATES; from++) {
					for (let to = Math.max(0, from - 1); to <= Math.min(WEIGHT_LEVELS, from + 1); to++) {
						const pairIndex = pairIndexOf(from, to);

						table[pairIndex] = Math.max(
							table[pairIndex] ?? 0,
							Math.abs(alpha + weightBetween(from, to, tau) * beta),
						);
					}
				}
			}
		}

		costs.push(table);
	}

	const floorPath = gentlestPathOf(costs, threshold);

	if (floorPath !== undefined) {
		return { costs, level: threshold, path: floorPath };
	}

	let low = threshold;
	let high = peak;

	for (let round = 0; round < BISECTION_ROUNDS; round++) {
		const middle = (low + high) / 2;

		if (gentlestPathOf(costs, middle) === undefined) {
			low = middle;
		} else {
			high = middle;
		}
	}

	const path = gentlestPathOf(costs, high);

	if (path === undefined) {
		throw new Error(`oracleOf: no path holds the level ${high}`);
	}

	return { costs, level: high, path };
};
