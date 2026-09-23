// eslint-disable-next-line comment-rules/no-restricted-comments
// Radix-2 transforms follow Cooley and Tukey, "An Algorithm for the Machine Calculation of Complex Fourier Series" (1965).

const isPositivePowerOfTwo = (value: number): boolean =>
	Number.isSafeInteger(value) && value > 0 && 2 ** Math.round(Math.log2(value)) === value;

const twiddlesOf = (size: number): { readonly real: Float64Array; readonly imaginary: Float64Array } => {
	const real = new Float64Array(Math.max(0, size - 1));
	const imaginary = new Float64Array(Math.max(0, size - 1));
	let offset = 0;

	for (let step = 2; step <= size; step *= 2) {
		const halfStep = step / 2;
		const angle = (-2 * Math.PI) / step;

		for (let pair = 0; pair < halfStep; pair++) {
			real[offset + pair] = Math.cos(angle * pair);
			imaginary[offset + pair] = Math.sin(angle * pair);
		}

		offset += halfStep;
	}

	return { real, imaginary };
};

const bitReverse = (real: Float64Array, imaginary: Float64Array, size: number): void => {
	let reversed = 0;

	for (let index = 0; index < size - 1; index++) {
		if (index < reversed) {
			const swappedReal = real[index] ?? 0;
			const swappedImaginary = imaginary[index] ?? 0;

			real[index] = real[reversed] ?? 0;
			imaginary[index] = imaginary[reversed] ?? 0;
			real[reversed] = swappedReal;
			imaginary[reversed] = swappedImaginary;
		}

		let bit = size >> 1;

		while (bit <= reversed) {
			reversed -= bit;
			bit >>= 1;
		}

		reversed += bit;
	}
};

export const nextPowerOfTwo = (value: number): number => {
	let size = 2;

	while (size < value) {
		size *= 2;
	}

	return size;
};

export class Fft {
	readonly size: number;
	private readonly twiddleReal: Float64Array;
	private readonly twiddleImaginary: Float64Array;

	constructor(size: number) {
		if (!isPositivePowerOfTwo(size)) {
			throw new Error(`Fft: size must be a positive power of two, got ${size}`);
		}

		this.size = size;

		const twiddles = twiddlesOf(size);

		this.twiddleReal = twiddles.real;
		this.twiddleImaginary = twiddles.imaginary;
	}

	forward(real: Float64Array, imaginary: Float64Array): void {
		this.assertCapacity(real, imaginary);

		if (this.size <= 1) {
			return;
		}

		bitReverse(real, imaginary, this.size);
		this.butterfly(real, imaginary);
	}

	inverse(real: Float64Array, imaginary: Float64Array): void {
		this.assertCapacity(real, imaginary);

		if (this.size <= 1) {
			return;
		}

		for (let index = 0; index < this.size; index++) {
			imaginary[index] = -(imaginary[index] ?? 0);
		}

		this.forward(real, imaginary);

		const scale = 1 / this.size;

		for (let index = 0; index < this.size; index++) {
			real[index] = (real[index] ?? 0) * scale;
			imaginary[index] = -(imaginary[index] ?? 0) * scale;
		}
	}

	private assertCapacity(real: Float64Array, imaginary: Float64Array): void {
		if (real.length < this.size) {
			throw new Error(`Fft: real capacity must be at least ${this.size}, got ${real.length}`);
		}

		if (imaginary.length < this.size) {
			throw new Error(`Fft: imaginary capacity must be at least ${this.size}, got ${imaginary.length}`);
		}
	}

	private butterfly(real: Float64Array, imaginary: Float64Array): void {
		const twiddleReal = this.twiddleReal;
		const twiddleImaginary = this.twiddleImaginary;
		const size = this.size;
		let twiddleOffset = 0;

		for (let step = 2; step <= size; step *= 2) {
			const halfStep = step / 2;

			for (let group = 0; group < size; group += step) {
				for (let pair = 0; pair < halfStep; pair++) {
					const wr = twiddleReal[twiddleOffset + pair] ?? 0;
					const wi = twiddleImaginary[twiddleOffset + pair] ?? 0;
					const evenIndex = group + pair;
					const oddIndex = evenIndex + halfStep;
					const oddReal = real[oddIndex] ?? 0;
					const oddImaginary = imaginary[oddIndex] ?? 0;
					const evenReal = real[evenIndex] ?? 0;
					const evenImaginary = imaginary[evenIndex] ?? 0;
					const tReal = oddReal * wr - oddImaginary * wi;
					const tImaginary = oddReal * wi + oddImaginary * wr;

					real[oddIndex] = evenReal - tReal;
					imaginary[oddIndex] = evenImaginary - tImaginary;
					real[evenIndex] = evenReal + tReal;
					imaginary[evenIndex] = evenImaginary + tImaginary;
				}
			}

			twiddleOffset += halfStep;
		}
	}
}
