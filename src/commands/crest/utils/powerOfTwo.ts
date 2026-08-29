export const isPowerOfTwo = (value: number): boolean =>
	Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
