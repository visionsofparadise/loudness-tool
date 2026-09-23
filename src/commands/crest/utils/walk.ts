export const DELTA_COUNT = 3;

export interface StepPairs {
	readonly stepCount: number;
	readonly pairCount: number;
	readonly isAdmissible: Uint8Array;
	readonly successorPair: Int32Array;
}

export const pairIndexOf = (beginStepIndex: number, endStepIndex: number): number =>
	beginStepIndex * DELTA_COUNT + (endStepIndex - beginStepIndex + 1);

export const beginStepIndexOf = (pairIndex: number): number => Math.floor(pairIndex / DELTA_COUNT);

export const endStepIndexOf = (pairIndex: number): number =>
	beginStepIndexOf(pairIndex) + (pairIndex % DELTA_COUNT) - 1;

export const stepPairsOf = (stepCount: number): StepPairs => {
	const pairCount = stepCount * DELTA_COUNT;
	const isAdmissible = new Uint8Array(pairCount);
	const successorPair = new Int32Array(pairCount * DELTA_COUNT).fill(-1);

	for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
		const endStepIndex = endStepIndexOf(pairIndex);

		if (endStepIndex < 0 || endStepIndex >= stepCount) {
			continue;
		}

		isAdmissible[pairIndex] = 1;

		for (let code = 0; code < DELTA_COUNT; code++) {
			const nextEndStepIndex = endStepIndex + code - 1;

			if (nextEndStepIndex >= 0 && nextEndStepIndex < stepCount) {
				successorPair[pairIndex * DELTA_COUNT + code] = pairIndexOf(endStepIndex, nextEndStepIndex);
			}
		}
	}

	return { stepCount, pairCount, isAdmissible, successorPair };
};
