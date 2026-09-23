import { beginStepIndexOf, endStepIndexOf, DELTA_COUNT, type StepPairs } from "./walk";

export interface ChainRegion {
	readonly firstStretch: number;
	readonly lastStretch: number;
	readonly leftFree: boolean;
	readonly rightFree: boolean;
}

export interface ChainTables {
	readonly pairs: StepPairs;
	readonly zeroPairIndex: number;
	readonly readings: Float64Array;
	readonly soloLevels: ReadonlyMap<number, Float64Array>;
	readonly levels: ReadonlyMap<number, Float64Array>;
	readonly identicalFrames: ReadonlyMap<number, Int32Array>;
}

const EMPTY_LEVELS = new Float64Array(0);
const EMPTY_COUNTS = new Int32Array(0);

const initialLevelsOf = (tables: ChainTables, region: ChainRegion): Float64Array => {
	const reached = new Float64Array(tables.pairs.pairCount).fill(Infinity);

	if (!region.leftFree) {
		reached[tables.zeroPairIndex] = tables.readings[region.firstStretch] ?? Infinity;

		return reached;
	}

	const soloLevels = tables.soloLevels.get(region.firstStretch) ?? EMPTY_LEVELS;

	for (let pairIndex = 0; pairIndex < tables.pairs.pairCount; pairIndex++) {
		if (tables.pairs.isAdmissible[pairIndex] === 1) {
			reached[pairIndex] = soloLevels[pairIndex] ?? Infinity;
		}
	}

	return reached;
};

const finalPairsOf = (tables: ChainTables, region: ChainRegion): Array<number> => {
	if (!region.rightFree) {
		return [tables.zeroPairIndex];
	}

	const pairIndices: Array<number> = [];

	for (let pairIndex = 0; pairIndex < tables.pairs.pairCount; pairIndex++) {
		pairIndices.push(pairIndex);
	}

	return pairIndices;
};

export const chainLevelOf = (tables: ChainTables, region: ChainRegion): number => {
	const { pairs } = tables;
	let reached = initialLevelsOf(tables, region);

	for (let stretchIndex = region.firstStretch + 1; stretchIndex <= region.lastStretch; stretchIndex++) {
		const levels = tables.levels.get(stretchIndex) ?? EMPTY_LEVELS;
		const next = new Float64Array(pairs.pairCount).fill(Infinity);

		for (let carryPair = 0; carryPair < pairs.pairCount; carryPair++) {
			const carried = reached[carryPair] ?? Infinity;

			if (carried === Infinity) {
				continue;
			}

			for (let code = 0; code < DELTA_COUNT; code++) {
				const pairIndex = pairs.successorPair[carryPair * DELTA_COUNT + code] ?? -1;

				if (pairIndex < 0) {
					continue;
				}

				const level = Math.max(carried, levels[carryPair * DELTA_COUNT + code] ?? Infinity);

				if (level < (next[pairIndex] ?? Infinity)) {
					next[pairIndex] = level;
				}
			}
		}

		reached = next;
	}

	let level = Infinity;

	for (const pairIndex of finalPairsOf(tables, region)) {
		level = Math.min(level, reached[pairIndex] ?? Infinity);
	}

	return level;
};

export const chainWalkOf = (tables: ChainTables, region: ChainRegion, level: number): Int32Array => {
	const { pairs } = tables;
	const stretchCount = region.lastStretch - region.firstStretch + 1;
	const joins = new Int32Array(stretchCount + 1);
	const fromPairs: Array<Int32Array> = [];
	const initial = initialLevelsOf(tables, region);
	const firstCounts = tables.identicalFrames.get(region.firstStretch) ?? EMPTY_COUNTS;
	let totals = new Float64Array(pairs.pairCount).fill(-Infinity);

	for (let pairIndex = 0; pairIndex < pairs.pairCount; pairIndex++) {
		if ((initial[pairIndex] ?? Infinity) <= level) {
			totals[pairIndex] = firstCounts[pairIndex] ?? 0;
		}
	}

	for (let stretchIndex = region.firstStretch + 1; stretchIndex <= region.lastStretch; stretchIndex++) {
		const levels = tables.levels.get(stretchIndex) ?? EMPTY_LEVELS;
		const counts = tables.identicalFrames.get(stretchIndex) ?? EMPTY_COUNTS;
		const next = new Float64Array(pairs.pairCount).fill(-Infinity);
		const fromPair = new Int32Array(pairs.pairCount).fill(-1);

		for (let carryPair = 0; carryPair < pairs.pairCount; carryPair++) {
			const carried = totals[carryPair] ?? -Infinity;

			if (carried === -Infinity) {
				continue;
			}

			for (let code = 0; code < DELTA_COUNT; code++) {
				const pairIndex = pairs.successorPair[carryPair * DELTA_COUNT + code] ?? -1;

				if (pairIndex < 0 || (levels[carryPair * DELTA_COUNT + code] ?? Infinity) > level) {
					continue;
				}

				const total = carried + (counts[pairIndex] ?? 0);

				if (total > (next[pairIndex] ?? -Infinity)) {
					next[pairIndex] = total;
					fromPair[pairIndex] = carryPair;
				}
			}
		}

		totals = next;
		fromPairs.push(fromPair);
	}

	let bestPair = -1;

	for (const pairIndex of finalPairsOf(tables, region)) {
		if ((totals[pairIndex] ?? -Infinity) > (bestPair < 0 ? -Infinity : (totals[bestPair] ?? -Infinity))) {
			bestPair = pairIndex;
		}
	}

	if (bestPair < 0) {
		return joins;
	}

	let pairIndex = bestPair;

	for (let offset = stretchCount - 1; offset >= 0; offset--) {
		joins[offset] = beginStepIndexOf(pairIndex);
		joins[offset + 1] = endStepIndexOf(pairIndex);

		const carryPair = fromPairs[offset - 1]?.[pairIndex] ?? -1;

		if (carryPair < 0) {
			break;
		}

		pairIndex = carryPair;
	}

	return joins;
};
