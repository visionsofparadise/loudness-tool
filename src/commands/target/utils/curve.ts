export interface Anchors {
	floorDb: number | null;
	pivotDb: number;
	limitDb: number;
	B: number;
	peakGainDb: number;
}

export const gainDbAt = (absXDb: number, anchors: Anchors): number => {
	const { floorDb, pivotDb, limitDb, B: boost, peakGainDb } = anchors;

	if (floorDb !== null && absXDb <= floorDb) {
		return 0;
	}

	if (absXDb < pivotDb) {
		if (floorDb === null) {
			return boost;
		}

		const position = (absXDb - floorDb) / (pivotDb - floorDb);

		return position * boost;
	}

	if (absXDb < limitDb) {
		const position = (absXDb - pivotDb) / (limitDb - pivotDb);

		return boost + position * (peakGainDb - boost);
	}

	return limitDb + peakGainDb - absXDb;
};
