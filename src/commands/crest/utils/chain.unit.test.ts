import { describe, expect, it } from "vitest";
import { chainLevelOf, chainWalkOf, type ChainTables } from "./chain";
import { pairIndexOf, stepPairsOf, DELTA_COUNT } from "./walk";

const STEP_COUNT = 3;
const ZERO_STEP_INDEX = 1;
const QUIET_LEVEL = -6;
const SOURCE_LEVEL = 0;

const tablesOf = (stretchCount: number, readings: Array<number>): ChainTables => {
	const pairs = stepPairsOf(STEP_COUNT);
	const zeroPairIndex = pairIndexOf(ZERO_STEP_INDEX, ZERO_STEP_INDEX);
	const soloLevels = new Map<number, Float64Array>();
	const levels = new Map<number, Float64Array>();
	const identicalFrames = new Map<number, Int32Array>();
	const levelOf = (pairIndex: number): number => (pairIndex === zeroPairIndex ? SOURCE_LEVEL : QUIET_LEVEL);

	for (let stretchIndex = 0; stretchIndex < stretchCount; stretchIndex++) {
		const solo = new Float64Array(pairs.pairCount).fill(Infinity);
		const counts = new Int32Array(pairs.pairCount);
		const stretchLevels = new Float64Array(pairs.pairCount * DELTA_COUNT).fill(Infinity);

		for (let pairIndex = 0; pairIndex < pairs.pairCount; pairIndex++) {
			if (pairs.isAdmissible[pairIndex] !== 1) {
				continue;
			}

			solo[pairIndex] = levelOf(pairIndex);
			counts[pairIndex] = pairIndex === zeroPairIndex ? 10 : 1;

			for (let code = 0; code < DELTA_COUNT; code++) {
				const successor = pairs.successorPair[pairIndex * DELTA_COUNT + code] ?? -1;

				if (successor >= 0) {
					stretchLevels[pairIndex * DELTA_COUNT + code] = levelOf(successor);
				}
			}
		}

		soloLevels.set(stretchIndex, solo);
		levels.set(stretchIndex, stretchLevels);
		identicalFrames.set(stretchIndex, counts);
	}

	return { pairs, zeroPairIndex, readings: Float64Array.from(readings), soloLevels, levels, identicalFrames };
};

describe("chainLevelOf", () => {
	it("holds the region's edges on the source where they are pinned", () => {
		const tables = tablesOf(3, [-2, -2, -2]);

		expect(chainLevelOf(tables, { firstStretch: 0, lastStretch: 2, leftFree: false, rightFree: false })).toBe(
			SOURCE_LEVEL,
		);
	});

	it("reaches lower with the region's edges free", () => {
		const tables = tablesOf(3, [-2, -2, -2]);

		expect(chainLevelOf(tables, { firstStretch: 0, lastStretch: 2, leftFree: true, rightFree: true })).toBe(
			QUIET_LEVEL,
		);
	});

	it("charges the pinned first stretch what the source reads there", () => {
		const tables = tablesOf(3, [SOURCE_LEVEL + 3, -2, -2]);

		expect(chainLevelOf(tables, { firstStretch: 0, lastStretch: 2, leftFree: false, rightFree: true })).toBe(
			SOURCE_LEVEL + 3,
		);
	});
});

describe("chainWalkOf", () => {
	it("leaves every pinned stretch on the source step", () => {
		const tables = tablesOf(3, [-2, -2, -2]);
		const joins = chainWalkOf(
			tables,
			{ firstStretch: 0, lastStretch: 2, leftFree: false, rightFree: false },
			SOURCE_LEVEL,
		);

		expect(Array.from(joins)).toEqual([ZERO_STEP_INDEX, ZERO_STEP_INDEX, ZERO_STEP_INDEX, ZERO_STEP_INDEX]);
	});

	it("walks off the source step where the level forbids it", () => {
		const tables = tablesOf(3, [-2, -2, -2]);
		const joins = chainWalkOf(
			tables,
			{ firstStretch: 0, lastStretch: 2, leftFree: true, rightFree: true },
			QUIET_LEVEL,
		);

		expect(Array.from(joins)).toEqual([0, 0, 0, 0]);
	});
});
