import { TRUE_PEAK_TAIL_FRAMES, type StretchMeasure } from "./render";

export const windowPositionsOf = (firstFrame: number, frameCount: number, isLast: boolean): Array<number> => {
	const positions: Array<number> = [];

	for (let offset = 0; offset < Math.min(TRUE_PEAK_TAIL_FRAMES, frameCount); offset++) {
		positions.push(firstFrame + offset);
	}

	if (isLast) {
		for (let offset = 0; offset < TRUE_PEAK_TAIL_FRAMES; offset++) {
			positions.push(firstFrame + frameCount + offset);
		}
	}

	return positions;
};

const addContribution = (
	values: Float64Array,
	measure: StretchMeasure,
	firstFrame: number,
	endFrame: number,
	position: number,
	stride: number,
): void => {
	const isInside = position <= endFrame;
	const offset = isInside ? position - firstFrame : position - endFrame - 1;

	if (offset < 0 || offset >= TRUE_PEAK_TAIL_FRAMES) {
		return;
	}

	const table = isInside ? measure.head : measure.carry;

	for (let index = 0; index < stride; index++) {
		values[index] = (values[index] ?? 0) + (table[offset * stride + index] ?? 0);
	}
};

export const chargeOf = (args: {
	measure: StretchMeasure;
	previousMeasure: StretchMeasure | undefined;
	firstFrame: number;
	endFrame: number;
	stretchFrames: number;
	positions: ReadonlyArray<number>;
	values: Float64Array;
	stride: number;
}): number => {
	const { measure, previousMeasure, firstFrame, endFrame, stretchFrames, positions, values, stride } = args;
	let peak = measure.peak;

	for (const position of positions) {
		values.fill(0);
		addContribution(values, measure, firstFrame, endFrame, position, stride);

		if (previousMeasure !== undefined) {
			addContribution(values, previousMeasure, firstFrame - stretchFrames, firstFrame - 1, position, stride);
		}

		for (let index = 0; index < stride; index++) {
			const magnitude = Math.abs(values[index] ?? 0);

			if (magnitude > peak) {
				peak = magnitude;
			}
		}
	}

	return peak;
};
