export interface BiquadCoefficients {
	readonly b0: number;
	readonly b1: number;
	readonly b2: number;
	readonly a1: number;
	readonly a2: number;
}

// eslint-disable-next-line comment-rules/no-restricted-comments
// Stage-1 (spherical-head) and RLB high-pass coefficients from ITU-R BS.1770-5 Table 1 and Table 2.

export const preFilterCoefficients = (sampleRate: number): BiquadCoefficients => {
	if (sampleRate === 48000) {
		return {
			b0: 1.53512485958697,
			b1: -2.69169618940638,
			b2: 1.19839281085285,
			a1: -1.69065929318241,
			a2: 0.73248077421585,
		};
	}

	const frequency = 1681.974450955533;
	const gain = 3.999843853973347;
	const quality = 0.7071752369554196;
	const kk = Math.tan((Math.PI * frequency) / sampleRate);
	const vh = Math.pow(10, gain / 20);
	const vb = Math.pow(vh, 0.4996667741545416);
	const a0 = 1 + kk / quality + kk * kk;

	return {
		b0: (vh + (vb * kk) / quality + kk * kk) / a0,
		b1: (2 * (kk * kk - vh)) / a0,
		b2: (vh - (vb * kk) / quality + kk * kk) / a0,
		a1: (2 * (kk * kk - 1)) / a0,
		a2: (1 - kk / quality + kk * kk) / a0,
	};
};

export const rlbFilterCoefficients = (sampleRate: number): BiquadCoefficients => {
	if (sampleRate === 48000) {
		return {
			b0: 1.0,
			b1: -2.0,
			b2: 1.0,
			a1: -1.99004745483398,
			a2: 0.99007225036621,
		};
	}

	const frequency = 38.13547087602444;
	const quality = 0.5003270373238773;
	const kk = Math.tan((Math.PI * frequency) / sampleRate);
	const a0 = 1 + kk / quality + kk * kk;

	return {
		b0: 1 / a0,
		b1: -2 / a0,
		b2: 1 / a0,
		a1: (2 * (kk * kk - 1)) / a0,
		a2: (1 - kk / quality + kk * kk) / a0,
	};
};
