// eslint-disable-next-line comment-rules/no-restricted-comments
// Normalized Gray–Markel lattice after Regalia, Mitra & Vaidyanathan (1988), Proc. IEEE 76(1):19–37.

export const LATTICE_ORDER = 8;

// eslint-disable-next-line comment-rules/no-restricted-comments
// RMV §III |k|<1 stability clamp
export const MAX_REFLECTION = 0.95;

// eslint-disable-next-line comment-rules/no-restricted-comments
// RMV §III Eq. 3.3a/3.3b step-down recursion.
export const stepDownToReflection = (denominator: ArrayLike<number>): Float64Array => {
	const order = denominator.length - 1;
	const reflection = new Float64Array(Math.max(0, order));

	if (order <= 0) {
		return reflection;
	}

	let current = Array.from(denominator, (value) => value);
	const lead = current[0] ?? 1;

	if (lead !== 0 && lead !== 1) {
		current = current.map((value) => value / lead);
	}

	for (let sectionOrder = order; sectionOrder >= 1; sectionOrder--) {
		let km = current[sectionOrder] ?? 0;

		if (!Number.isFinite(km)) {
			km = 0;
		}

		km = Math.max(-MAX_REFLECTION, Math.min(MAX_REFLECTION, km));
		reflection[sectionOrder - 1] = km;

		const denom = 1 - km * km;
		const next = new Array<number>(sectionOrder).fill(0);

		for (let index = 0; index < sectionOrder; index++) {
			next[index] = ((current[index] ?? 0) - km * (current[sectionOrder - index] ?? 0)) / denom;
		}

		next[0] = 1;
		current = next;
	}

	return reflection;
};

// eslint-disable-next-line comment-rules/no-restricted-comments
// Orthogonal first-order normalized all-pass section (RMV Fig. 4(b)): energy-preserving every sample.
export const applyLatticeSample = (
	input: number,
	state: Float64Array,
	reflectionRow: ArrayLike<number>,
	scale: number,
	order: number,
): number => {
	let signalValue = input;

	for (let section = 0; section < order; section++) {
		let kCoeff = scale * (reflectionRow[section] ?? 0);

		if (kCoeff > MAX_REFLECTION) {
			kCoeff = MAX_REFLECTION;
		} else if (kCoeff < -MAX_REFLECTION) {
			kCoeff = -MAX_REFLECTION;
		}

		const cCoeff = Math.sqrt(Math.max(0, 1 - kCoeff * kCoeff));
		const delayed = state[section] ?? 0;
		const toDelay = cCoeff * signalValue + kCoeff * delayed;
		const sectionOut = -kCoeff * signalValue + cCoeff * delayed;

		state[section] = toDelay;
		signalValue = sectionOut;
	}

	return signalValue;
};

export const applyLatticeChannel = (
	signal: Float64Array,
	reflectionRow: ArrayLike<number>,
	scale: number,
	order: number,
): Float64Array => {
	const output = new Float64Array(signal.length);
	const state = new Float64Array(order);

	for (let sample = 0; sample < signal.length; sample++) {
		output[sample] = applyLatticeSample(signal[sample] ?? 0, state, reflectionRow, scale, order);
	}

	return output;
};
