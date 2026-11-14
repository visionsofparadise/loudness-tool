export const dbToLinear = (db: number): number => {
	if (db === -Infinity) {
		return 0;
	}

	return Math.pow(10, db / 20);
};

export const linearToDb = (linear: number): number => 20 * Math.log10(Math.max(linear, 1e-10));

export const peakDbOrNull = (linear: number): number | null =>
	linear === 0 || !Number.isFinite(linear) ? null : 20 * Math.log10(linear);

export const lufsOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null);

export const fixedText = (value: number, digits: number): string => {
	const text = value.toFixed(digits);

	return Number(text) === 0 ? (0).toFixed(digits) : text;
};

export const figureText = (value: number | null, digits: number, unit: string): string =>
	value === null || !Number.isFinite(value) ? "n/a" : `${fixedText(value, digits)} ${unit}`;
