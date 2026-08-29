import { describe, expect, it } from "vitest";
import { Fft, hannWindow } from "./Fft";

const ORACLE_SIZES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

interface ComplexResult {
	readonly real: Float64Array;
	readonly imag: Float64Array;
}

const createComplexInput = (size: number): { real: Float64Array; imag: Float64Array } => {
	const real = new Float64Array(size);
	const imag = new Float64Array(size);

	for (let index = 0; index < size; index++) {
		real[index] = Math.sin(index * 0.37) + 0.2 * Math.cos(index * 1.13) + index * 0.003;
		imag[index] = 0.35 * Math.cos(index * 0.61) - 0.1 * Math.sin(index * 0.17);
	}

	return { real, imag };
};

const directTransform = (real: ArrayLike<number>, imag: ArrayLike<number>): ComplexResult => {
	const size = real.length;
	const outputReal = new Float64Array(size);
	const outputImag = new Float64Array(size);

	for (let bin = 0; bin < size; bin++) {
		let sumReal = 0;
		let sumImag = 0;

		for (let index = 0; index < size; index++) {
			const angle = (-2 * Math.PI * bin * index) / size;
			const cosine = Math.cos(angle);
			const sine = Math.sin(angle);
			const inputReal = real[index] ?? 0;
			const inputImag = imag[index] ?? 0;

			sumReal += inputReal * cosine - inputImag * sine;
			sumImag += inputReal * sine + inputImag * cosine;
		}

		outputReal[bin] = sumReal;
		outputImag[bin] = sumImag;
	}

	return { real: outputReal, imag: outputImag };
};

const maxComplexError = (
	actualReal: ArrayLike<number>,
	actualImag: ArrayLike<number>,
	expected: ComplexResult,
): number => {
	let maxError = 0;

	for (let index = 0; index < expected.real.length; index++) {
		maxError = Math.max(
			maxError,
			Math.abs((actualReal[index] ?? 0) - (expected.real[index] ?? 0)),
			Math.abs((actualImag[index] ?? 0) - (expected.imag[index] ?? 0)),
		);
	}

	return maxError;
};

const energyOf = (real: ArrayLike<number>, imag: ArrayLike<number>): number => {
	let energy = 0;

	for (let index = 0; index < real.length; index++) {
		const re = real[index] ?? 0;
		const im = imag[index] ?? 0;

		energy += re * re + im * im;
	}

	return energy;
};

const oracleToleranceOf = (size: number): number => (size >= 1024 ? 1e-8 : 1e-10);

describe("Fft validation", () => {
	it.each([0, -1, 1.5, 3, 6, 7, 6442450944, 2 ** 51 + 1, Number.POSITIVE_INFINITY, Number.NaN])(
		"rejects invalid size %s",
		(size) => {
			expect(() => new Fft(size)).toThrow("positive power of two");
		},
	);

	it("allows size one", () => {
		const fft = new Fft(1);
		const real = new Float64Array([0.75]);
		const imag = new Float64Array([-0.25]);

		fft.forward(real, imag);

		expect(real[0]).toBe(0.75);
		expect(imag[0]).toBe(-0.25);
	});

	it("rejects undersized arrays before mutation", () => {
		const fft = new Fft(4);
		const full = new Float64Array(4);
		const short = new Float64Array(3);
		const real = new Float64Array(4).fill(9);
		const imag = new Float64Array(4).fill(8);

		expect(() => fft.forward(short, full)).toThrow("real capacity");
		expect(() => fft.forward(full, short)).toThrow("imaginary capacity");
		expect(Array.from(real)).toEqual([9, 9, 9, 9]);
		expect(Array.from(imag)).toEqual([8, 8, 8, 8]);
	});

	it("leaves suffix capacity untouched", () => {
		const size = 4;
		const fft = new Fft(size);
		const input = createComplexInput(6);
		const expected = directTransform(input.real.subarray(0, size), input.imag.subarray(0, size));
		const real = new Float64Array(6).fill(99);
		const imag = new Float64Array(6).fill(98);

		real.set(input.real.subarray(0, size));
		imag.set(input.imag.subarray(0, size));
		fft.forward(real, imag);

		expect(maxComplexError(real.subarray(0, size), imag.subarray(0, size), expected)).toBeLessThan(1e-10);
		expect(Array.from(real.subarray(size))).toEqual([99, 99]);
		expect(Array.from(imag.subarray(size))).toEqual([98, 98]);
	});
});

describe("Fft direct oracles", () => {
	it.each(ORACLE_SIZES)("matches every direct Float64 DFT bin for size %i", (size) => {
		const fft = new Fft(size);
		const input = createComplexInput(size);
		const expected = directTransform(input.real, input.imag);
		const real = Float64Array.from(input.real);
		const imag = Float64Array.from(input.imag);

		fft.forward(real, imag);

		expect(maxComplexError(real, imag, expected)).toBeLessThan(oracleToleranceOf(size));
	});

	it.each(ORACLE_SIZES)("satisfies Parseval for size %i", (size) => {
		const fft = new Fft(size);
		const input = createComplexInput(size);
		const real = Float64Array.from(input.real);
		const imag = Float64Array.from(input.imag);
		const timeEnergy = energyOf(real, imag);

		fft.forward(real, imag);

		const frequencyEnergy = energyOf(real, imag);

		expect(Math.abs(timeEnergy - frequencyEnergy / size)).toBeLessThan(
			oracleToleranceOf(size) * Math.max(1, timeEnergy),
		);
	});
});

describe("hannWindow", () => {
	it("returns [1] for a one-sample window", () => {
		expect(Array.from(hannWindow(1))).toEqual([1]);
	});

	it("is the periodic Hann window", () => {
		const window = hannWindow(4);

		expect(window[0]).toBeCloseTo(0, 12);
		expect(window[1]).toBeCloseTo(0.5, 12);
		expect(window[2]).toBeCloseTo(1, 12);
		expect(window[3]).toBeCloseTo(0.5, 12);
	});

	it.each([0, -1, 1.5, Number.NaN])("rejects invalid size %s", (size) => {
		expect(() => hannWindow(size)).toThrow("positive integer");
	});
});
