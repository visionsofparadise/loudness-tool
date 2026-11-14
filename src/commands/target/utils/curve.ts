export interface Anchors {
	floorDb: number | null;
	pivotDb: number;
	kneeDb: number | null;
	limitDb: number;
	ceilingDb: number;
	B: number;
	peakGainDb: number;
}

const rampOf = (value: number, start: number, end: number): number => {
	if (value <= start) {
		return 0;
	}

	if (value >= end) {
		return 1;
	}

	return (value - start) / (end - start);
};

export const gainDbAt = (loudnessDb: number, peakDb: number, anchors: Anchors): number => {
	const { floorDb, pivotDb, kneeDb, limitDb, ceilingDb, B: boost, peakGainDb } = anchors;
	const peakWeight = kneeDb === null ? 0 : rampOf(peakDb, kneeDb, limitDb);
	const raw = (1 - peakWeight) * boost + peakWeight * peakGainDb;
	const raiseWeight = floorDb === null ? 1 : rampOf(loudnessDb, floorDb, pivotDb);
	const gainDb = raw <= 0 ? raw : raiseWeight * raw;

	return Math.min(gainDb, ceilingDb - peakDb);
};
