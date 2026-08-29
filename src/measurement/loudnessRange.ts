// eslint-disable-next-line comment-rules/no-restricted-comments
// Loudness-range gating and percentile selection follow EBU Tech 3342 v3.0.

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_OFFSET_LU = -20;
const LOW_PERCENTILE = 0.1;
const HIGH_PERCENTILE = 0.95;

const consideredLoudnessOf = (shortTerm: Float64Array): Array<number> => {
	const absoluteGated: Array<number> = [];

	for (let index = 0; index < shortTerm.length; index++) {
		const value = shortTerm[index] ?? 0;

		if (value >= ABSOLUTE_GATE_LUFS) {
			absoluteGated.push(value);
		}
	}

	if (absoluteGated.length === 0) {
		return [];
	}

	let absoluteSum = 0;

	for (let index = 0; index < absoluteGated.length; index++) {
		absoluteSum += Math.pow(10, (absoluteGated[index] ?? 0) / 10);
	}

	const relativeThreshold = 10 * Math.log10(absoluteSum / absoluteGated.length) + RELATIVE_GATE_OFFSET_LU;
	const considered: Array<number> = [];

	for (let index = 0; index < absoluteGated.length; index++) {
		const value = absoluteGated[index] ?? 0;

		if (value >= relativeThreshold) {
			considered.push(value);
		}
	}

	return considered;
};

export const computeLoudnessRange = (shortTerm: Float64Array): number => {
	const considered = consideredLoudnessOf(shortTerm);

	if (considered.length < 2) {
		return 0;
	}

	considered.sort((left, right) => left - right);

	const lowIndex = Math.round((considered.length - 1) * LOW_PERCENTILE);
	const highIndex = Math.round((considered.length - 1) * HIGH_PERCENTILE);

	return (considered[highIndex] ?? 0) - (considered[lowIndex] ?? 0);
};
