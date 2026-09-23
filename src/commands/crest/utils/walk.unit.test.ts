import { describe, expect, it } from "vitest";
import { beginStepIndexOf, endStepIndexOf, pairIndexOf, stepPairsOf, DELTA_COUNT } from "./walk";

const STEP_COUNT = 5;

describe("pairIndexOf", () => {
	it("round trips a begin and end one step apart at most", () => {
		for (let beginStepIndex = 0; beginStepIndex < STEP_COUNT; beginStepIndex++) {
			for (let delta = -1; delta <= 1; delta++) {
				const pairIndex = pairIndexOf(beginStepIndex, beginStepIndex + delta);

				expect(beginStepIndexOf(pairIndex)).toBe(beginStepIndex);
				expect(endStepIndexOf(pairIndex)).toBe(beginStepIndex + delta);
			}
		}
	});
});

describe("stepPairsOf", () => {
	it("admits exactly the pairs whose end step is on the ladder", () => {
		const pairs = stepPairsOf(STEP_COUNT);
		const admitted: Array<string> = [];

		expect(pairs.pairCount).toBe(STEP_COUNT * DELTA_COUNT);

		for (let pairIndex = 0; pairIndex < pairs.pairCount; pairIndex++) {
			if (pairs.isAdmissible[pairIndex] === 1) {
				admitted.push(`${beginStepIndexOf(pairIndex)}->${endStepIndexOf(pairIndex)}`);
			}
		}

		expect(admitted).toEqual([
			"0->0",
			"0->1",
			"1->0",
			"1->1",
			"1->2",
			"2->1",
			"2->2",
			"2->3",
			"3->2",
			"3->3",
			"3->4",
			"4->3",
			"4->4",
		]);
	});

	it("makes a successor begin where its predecessor ended", () => {
		const pairs = stepPairsOf(STEP_COUNT);

		for (let pairIndex = 0; pairIndex < pairs.pairCount; pairIndex++) {
			if (pairs.isAdmissible[pairIndex] !== 1) {
				continue;
			}

			for (let code = 0; code < DELTA_COUNT; code++) {
				const successor = pairs.successorPair[pairIndex * DELTA_COUNT + code] ?? -1;

				if (successor < 0) {
					expect(endStepIndexOf(pairIndex) + code - 1).not.toBe(
						Math.min(Math.max(endStepIndexOf(pairIndex) + code - 1, 0), STEP_COUNT - 1),
					);

					continue;
				}

				expect(pairs.isAdmissible[successor]).toBe(1);
				expect(beginStepIndexOf(successor)).toBe(endStepIndexOf(pairIndex));
				expect(endStepIndexOf(successor)).toBe(endStepIndexOf(pairIndex) + code - 1);
			}
		}
	});
});
