const LUFS_OFFSET = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_OFFSET_LU = -10;
const GATE_EQUALITY_TOLERANCE = 1e-9;

// eslint-disable-next-line comment-rules/no-restricted-comments
// Two-stage gating of overlapping 400 ms blocks follows ITU-R BS.1770-5 Annex 1.

const clearsGate = (power: number, thresholdPower: number): boolean =>
	power > thresholdPower * (1 + GATE_EQUALITY_TOLERANCE);

export const applyBs1770Gating = (blockSums: Float64Array, blockSize: number): number => {
	const blockCount = blockSums.length;

	if (blockCount === 0) {
		return -Infinity;
	}

	const absoluteThresholdPower = Math.pow(10, (ABSOLUTE_GATE_LUFS - LUFS_OFFSET) / 10);
	let absoluteSurvivorCount = 0;
	let absoluteSum = 0;

	for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
		const power = (blockSums[blockIndex] ?? 0) / blockSize;

		if (clearsGate(power, absoluteThresholdPower)) {
			absoluteSum += power;
			absoluteSurvivorCount++;
		}
	}

	if (absoluteSurvivorCount === 0) {
		return -Infinity;
	}

	const absoluteMean = absoluteSum / absoluteSurvivorCount;
	const relativeThresholdLufs = LUFS_OFFSET + 10 * Math.log10(absoluteMean) + RELATIVE_GATE_OFFSET_LU;
	const relativeThresholdPower = Math.pow(10, (relativeThresholdLufs - LUFS_OFFSET) / 10);
	let relativeSurvivorCount = 0;
	let relativeSum = 0;

	for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
		const power = (blockSums[blockIndex] ?? 0) / blockSize;

		if (clearsGate(power, absoluteThresholdPower) && clearsGate(power, relativeThresholdPower)) {
			relativeSum += power;
			relativeSurvivorCount++;
		}
	}

	if (relativeSurvivorCount === 0) {
		return -Infinity;
	}

	return LUFS_OFFSET + 10 * Math.log10(relativeSum / relativeSurvivorCount);
};
