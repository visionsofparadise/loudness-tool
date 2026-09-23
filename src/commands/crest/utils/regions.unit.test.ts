import { describe, expect, it } from "vitest";
import { markFreeStretches, rangesOf, regionsOf } from "./regions";

const freeSet = (stretchCount: number, ranges: Array<[number, number]>): Uint8Array => {
	const isFree = new Uint8Array(stretchCount);

	for (const [first, last] of ranges) {
		markFreeStretches(isFree, first, last);
	}

	return isFree;
};

describe("markFreeStretches", () => {
	it("clamps to the stretches the file has", () => {
		const isFree = freeSet(4, [[-3, 1]]);

		expect(Array.from(isFree)).toEqual([1, 1, 0, 0]);
		markFreeStretches(isFree, 3, 9);
		expect(Array.from(isFree)).toEqual([1, 1, 0, 1]);
	});
});

describe("regionsOf", () => {
	it("holds one stretch either side of a free run", () => {
		expect(regionsOf(freeSet(20, [[8, 10]]))).toEqual([{ firstStretch: 7, lastStretch: 11 }]);
	});

	it("keeps the collar inside the file at either end", () => {
		expect(regionsOf(freeSet(6, [[0, 1]]))).toEqual([{ firstStretch: 0, lastStretch: 2 }]);
		expect(regionsOf(freeSet(6, [[4, 5]]))).toEqual([{ firstStretch: 3, lastStretch: 5 }]);
	});

	it("leaves runs far apart as separate regions", () => {
		expect(
			regionsOf(
				freeSet(30, [
					[3, 4],
					[20, 21],
				]),
			),
		).toEqual([
			{ firstStretch: 2, lastStretch: 5 },
			{ firstStretch: 19, lastStretch: 22 },
		]);
	});

	it("merges runs whose collars overlap", () => {
		expect(
			regionsOf(
				freeSet(30, [
					[3, 4],
					[6, 7],
				]),
			),
		).toEqual([{ firstStretch: 2, lastStretch: 8 }]);
	});

	it("returns nothing when no stretch is free", () => {
		expect(regionsOf(new Uint8Array(10))).toEqual([]);
	});
});

describe("rangesOf", () => {
	it("gathers consecutive stretches into one range", () => {
		expect(rangesOf([2, 3, 4, 9, 11, 12])).toEqual([
			{ firstStretch: 2, lastStretch: 4 },
			{ firstStretch: 9, lastStretch: 9 },
			{ firstStretch: 11, lastStretch: 12 },
		]);
	});

	it("returns nothing for no stretches", () => {
		expect(rangesOf([])).toEqual([]);
	});
});
