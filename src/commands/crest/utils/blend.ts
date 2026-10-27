import { WEIGHT_LEVELS } from "./layout";
import { OVERSAMPLE_FACTOR } from "./render";

const CANDIDATE_FIELDS = 3;
const INITIAL_SLOTS = 64;

export const FLOOR = 0.6;
export const WEIGHT_STATES = WEIGHT_LEVELS + 1;
export const PAIR_COUNT = 31;

export const pairIndexOf = (from: number, to: number): number =>
	from < 0 || from > WEIGHT_LEVELS || to < 0 || to > WEIGHT_LEVELS || Math.abs(from - to) > 1 ? -1 : 2 * from + to;

export const weightBetween = (from: number, to: number, tau: number): number =>
	from / WEIGHT_LEVELS + (to / WEIGHT_LEVELS - from / WEIGHT_LEVELS) * tau;

export const candidatesOf = (args: {
	current: ReadonlyArray<Float64Array>;
	dispersed: ReadonlyArray<Float64Array>;
	frameCount: number;
	stretchFrames: number;
	threshold: number;
}): Float64Array => {
	const { current, dispersed, frameCount, stretchFrames, threshold } = args;
	const sampleCount = frameCount * OVERSAMPLE_FACTOR;
	const candidates = new Float64Array(current.length * sampleCount * CANDIDATE_FIELDS);
	let length = 0;

	for (let channelIndex = 0; channelIndex < current.length; channelIndex++) {
		const currentChannel = current[channelIndex];
		const dispersedChannel = dispersed[channelIndex];

		if (currentChannel === undefined || dispersedChannel === undefined) {
			continue;
		}

		for (let index = 0; index < sampleCount; index++) {
			const alpha = currentChannel[index] ?? 0;
			const dispersedValue = dispersedChannel[index] ?? 0;

			if (Math.max(Math.abs(alpha), Math.abs(dispersedValue)) <= threshold) {
				continue;
			}

			candidates[length] = alpha;
			candidates[length + 1] = dispersedValue - alpha;
			candidates[length + 2] = (Math.floor(index / OVERSAMPLE_FACTOR) + 1) / stretchFrames;
			length += CANDIDATE_FIELDS;
		}
	}

	return candidates.subarray(0, length);
};

export const costTableOf = (candidates: Float64Array): Float64Array => {
	const costs = new Float64Array(PAIR_COUNT);

	for (let from = 0; from < WEIGHT_STATES; from++) {
		for (let to = Math.max(0, from - 1); to <= Math.min(WEIGHT_LEVELS, from + 1); to++) {
			let peak = 0;

			for (let offset = 0; offset < candidates.length; offset += CANDIDATE_FIELDS) {
				const alpha = candidates[offset] ?? 0;
				const beta = candidates[offset + 1] ?? 0;
				const tau = candidates[offset + 2] ?? 0;

				peak = Math.max(peak, Math.abs(alpha + weightBetween(from, to, tau) * beta));
			}

			costs[pairIndexOf(from, to)] = peak;
		}
	}

	return costs;
};

const lowestOf = (costs: Float64Array): number => costs.reduce((lowest, cost) => Math.min(lowest, cost), Infinity);

export class WindowedSolve {
	readonly seedStretch: number;
	readonly seedThreshold: number;

	private readonly peaks: Float64Array;
	private readonly slotOf: Int32Array;
	private store = new Float64Array(INITIAL_SLOTS * PAIR_COUNT);
	private slotCount = 0;
	private advanced = 0;
	private highest: number;
	private best = new Float64Array(WEIGHT_STATES).fill(Infinity);
	private next = new Float64Array(WEIGHT_STATES);

	constructor(args: { peaks: Float64Array }) {
		const { peaks } = args;
		let seedStretch = peaks.length === 0 ? -1 : 0;

		for (let stretchIndex = 1; stretchIndex < peaks.length; stretchIndex++) {
			if ((peaks[stretchIndex] ?? 0) > (peaks[seedStretch] ?? 0)) {
				seedStretch = stretchIndex;
			}
		}

		this.peaks = peaks;
		this.slotOf = new Int32Array(peaks.length).fill(-1);
		this.seedStretch = seedStretch;
		this.seedThreshold = FLOOR * (peaks[seedStretch] ?? 0);
		this.highest = this.seedThreshold;
		this.best[0] = 0;
	}

	seed(costs: Float64Array): void {
		if (this.advanced > 0) {
			throw new Error(`WindowedSolve: seeded after advancing ${this.advanced} stretches`);
		}

		this.highest = Math.max(this.seedThreshold, lowestOf(costs));
	}

	nearStretches(): Uint8Array {
		const { peaks } = this;
		const near = new Uint8Array(peaks.length);
		let lastHot = -Infinity;

		for (let stretchIndex = 0; stretchIndex < peaks.length; stretchIndex++) {
			if ((peaks[stretchIndex] ?? 0) > this.highest) {
				lastHot = stretchIndex;
			}

			if (stretchIndex - lastHot <= WEIGHT_LEVELS) {
				near[stretchIndex] = 1;
			}
		}

		lastHot = Infinity;

		for (let stretchIndex = peaks.length - 1; stretchIndex >= 0; stretchIndex--) {
			if ((peaks[stretchIndex] ?? 0) > this.highest) {
				lastHot = stretchIndex;
			}

			if (lastHot - stretchIndex <= WEIGHT_LEVELS) {
				near[stretchIndex] = 1;
			}
		}

		return near;
	}

	isNear(stretchIndex: number): boolean {
		const last = Math.min(this.peaks.length - 1, stretchIndex + WEIGHT_LEVELS);

		for (let index = Math.max(0, stretchIndex - WEIGHT_LEVELS); index <= last; index++) {
			if ((this.peaks[index] ?? 0) > this.highest) {
				return true;
			}
		}

		return false;
	}

	threshold(): number {
		return this.highest;
	}

	advance(stretchIndex: number, costs: Float64Array | undefined): void {
		if (stretchIndex >= this.peaks.length) {
			throw new Error(`WindowedSolve: advanced stretch ${stretchIndex} of ${this.peaks.length}`);
		}

		if (stretchIndex !== this.advanced) {
			throw new Error(`WindowedSolve: advanced stretch ${stretchIndex}, expected ${this.advanced}`);
		}

		const { best, next } = this;

		next.fill(Infinity);

		if (costs === undefined) {
			next[0] = best[0] ?? Infinity;
		} else {
			for (let from = 0; from < WEIGHT_STATES; from++) {
				for (let to = Math.max(0, from - 1); to <= Math.min(WEIGHT_LEVELS, from + 1); to++) {
					next[to] = Math.min(
						next[to] ?? Infinity,
						Math.max(best[from] ?? Infinity, costs[pairIndexOf(from, to)] ?? Infinity),
					);
				}
			}

			this.keep(stretchIndex, costs);
			this.highest = Math.max(this.highest, lowestOf(costs));
		}

		this.best = next;
		this.next = best;
		this.advanced++;
	}

	costsOf(stretchIndex: number): Float64Array | undefined {
		const slot = this.slotOf[stretchIndex] ?? -1;

		return slot < 0 ? undefined : this.store.subarray(slot * PAIR_COUNT, (slot + 1) * PAIR_COUNT);
	}

	level(): number {
		return Math.max(this.seedThreshold, this.highest, this.best[0] ?? Infinity);
	}

	path(): Int32Array {
		const stretchCount = this.peaks.length;

		if (stretchCount === 0) {
			return Int32Array.of(0);
		}

		const level = this.level();
		const isAllowed = (stretchIndex: number, from: number, to: number): boolean => {
			const costs = this.costsOf(stretchIndex);

			return costs === undefined ? from === 0 && to === 0 : (costs[pairIndexOf(from, to)] ?? Infinity) <= level;
		};
		const reachable = new Uint8Array((stretchCount + 1) * WEIGHT_STATES);

		reachable[stretchCount * WEIGHT_STATES] = 1;

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

		if (reachable[0] !== 1) {
			throw new Error(`WindowedSolve: no path holds the level ${level}`);
		}

		const path = new Int32Array(stretchCount + 1);

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
	}

	private keep(stretchIndex: number, costs: Float64Array): void {
		if ((this.slotCount + 1) * PAIR_COUNT > this.store.length) {
			const grown = new Float64Array(this.store.length * 2);

			grown.set(this.store);
			this.store = grown;
		}

		this.store.set(costs.subarray(0, PAIR_COUNT), this.slotCount * PAIR_COUNT);
		this.slotOf[stretchIndex] = this.slotCount;
		this.slotCount++;
	}
}

export const weightOf = (path: Int32Array, frame: number, stretchFrames: number): number => {
	const stretchIndex = Math.floor(frame / stretchFrames);

	return weightBetween(
		path[stretchIndex] ?? 0,
		path[stretchIndex + 1] ?? 0,
		(frame - stretchIndex * stretchFrames + 1) / stretchFrames,
	);
};
