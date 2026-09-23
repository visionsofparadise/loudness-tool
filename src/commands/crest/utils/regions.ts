export interface StretchRange {
	readonly firstStretch: number;
	readonly lastStretch: number;
}

export const markFreeStretches = (isFree: Uint8Array, firstStretch: number, lastStretch: number): void => {
	const first = Math.max(0, firstStretch);
	const last = Math.min(isFree.length - 1, lastStretch);

	for (let stretchIndex = first; stretchIndex <= last; stretchIndex++) {
		isFree[stretchIndex] = 1;
	}
};

const extendRanges = (
	ranges: Array<StretchRange>,
	firstStretch: number,
	lastStretch: number,
	joinFrom: number,
): void => {
	const openIndex = ranges.length - 1;
	const open = ranges[openIndex];

	if (open !== undefined && open.lastStretch >= joinFrom) {
		ranges[openIndex] = { firstStretch: open.firstStretch, lastStretch };

		return;
	}

	ranges.push({ firstStretch, lastStretch });
};

export const regionsOf = (isFree: Uint8Array): Array<StretchRange> => {
	const regions: Array<StretchRange> = [];
	let runFirst = -1;

	for (let stretchIndex = 0; stretchIndex <= isFree.length; stretchIndex++) {
		if (stretchIndex < isFree.length && isFree[stretchIndex] === 1) {
			runFirst = runFirst < 0 ? stretchIndex : runFirst;

			continue;
		}

		if (runFirst < 0) {
			continue;
		}

		const firstStretch = Math.max(0, runFirst - 1);

		extendRanges(regions, firstStretch, Math.min(isFree.length - 1, stretchIndex), firstStretch);
		runFirst = -1;
	}

	return regions;
};

export const rangesOf = (stretchIndices: ReadonlyArray<number>): Array<StretchRange> => {
	const ranges: Array<StretchRange> = [];

	for (const stretchIndex of stretchIndices) {
		extendRanges(ranges, stretchIndex, stretchIndex, stretchIndex - 1);
	}

	return ranges;
};
