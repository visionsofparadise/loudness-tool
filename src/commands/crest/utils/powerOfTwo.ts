export const isPowerOfTwo = (value: number): boolean =>
	Number.isSafeInteger(value) && value > 0 && 2 ** Math.round(Math.log2(value)) === value;
