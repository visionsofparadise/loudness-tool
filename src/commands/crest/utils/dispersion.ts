export const dispersionKernelOf = (step: number): Float64Array => {
	const halfWidth = step < 0 ? -step : step;
	const length = 2 * halfWidth + 1;
	const kernel = new Float64Array(length);

	if (halfWidth === 0) {
		kernel[0] = 1;

		return kernel;
	}

	const turnCosines = new Float64Array(length);
	const turnSines = new Float64Array(length);

	for (let turn = 0; turn < length; turn++) {
		const angle = (2 * Math.PI * turn) / length;

		turnCosines[turn] = Math.cos(angle);
		turnSines[turn] = Math.sin(angle);
	}

	const binCosines = new Float64Array(halfWidth + 1);
	const binSines = new Float64Array(halfWidth + 1);

	for (let bin = 0; bin <= halfWidth; bin++) {
		const phase = (Math.PI * halfWidth * bin) / length - (2 * Math.PI * halfWidth * bin * bin) / (length * length);

		binCosines[bin] = Math.cos(phase);
		binSines[bin] = Math.sin(phase);
	}

	for (let position = 0; position < length; position++) {
		let sum = 1;

		for (let bin = 1; bin <= halfWidth; bin++) {
			const turn = (bin * position) % length;

			sum += 2 * ((binCosines[bin] ?? 0) * (turnCosines[turn] ?? 0) - (binSines[bin] ?? 0) * (turnSines[turn] ?? 0));
		}

		const offset = position <= halfWidth ? position : position - length;

		kernel[(step < 0 ? -offset : offset) + halfWidth] = sum / length;
	}

	return kernel;
};
