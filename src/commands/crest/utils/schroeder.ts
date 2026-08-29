// eslint-disable-next-line comment-rules/no-restricted-comments
// Schroeder (1970) near-optimal low-crest phase, per Ojarand & Min (2017) §I.A Eqs. (2)–(3),
// eslint-disable-next-line comment-rules/no-restricted-comments
// DOI 10.5755/j01.eie.23.2.18001.

export const relativePower = (magnitude: ArrayLike<number>): Float64Array => {
	const binCount = magnitude.length;
	const power = new Float64Array(binCount);

	if (binCount === 0) {
		return power;
	}

	let total = 0;

	for (let bin = 0; bin < binCount; bin++) {
		const value = magnitude[bin] ?? 0;
		const binPower = value * value;

		power[bin] = binPower;
		total += binPower;
	}

	if (total <= 0) {
		power.fill(1 / binCount);

		return power;
	}

	for (let bin = 0; bin < binCount; bin++) {
		power[bin] = (power[bin] ?? 0) / total;
	}

	return power;
};

// eslint-disable-next-line comment-rules/no-restricted-comments
// Ojarand & Min (2017) Eq. (2) Schroeder near-optimal phase.
export const schroederTargetPhase = (magnitude: ArrayLike<number>, phi1 = 0): Float64Array => {
	const binCount = magnitude.length;
	const phase = new Float64Array(binCount);

	if (binCount === 0) {
		return phase;
	}

	const power = relativePower(magnitude);
	let cumulative = 0;

	for (let bin = 0; bin < binCount; bin++) {
		phase[bin] = phi1 - 2 * Math.PI * cumulative;

		const oneBasedIndex = bin + 1;

		cumulative += (binCount - oneBasedIndex) * (power[bin] ?? 0);
	}

	return phase;
};
