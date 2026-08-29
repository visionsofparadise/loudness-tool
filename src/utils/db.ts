export const dbToLinear = (db: number): number => {
	if (db === -Infinity) {
		return 0;
	}

	return Math.pow(10, db / 20);
};

export const linearToDb = (linear: number): number => 20 * Math.log10(Math.max(linear, 1e-10));
