export interface BiquadCoefficients {
	readonly b0: number;
	readonly b1: number;
	readonly b2: number;
	readonly a1: number;
	readonly a2: number;
}

// eslint-disable-next-line comment-rules/no-restricted-comments
// Stage-1 (spherical-head) and RLB high-pass coefficients from ITU-R BS.1770-5 Table 1 and Table 2.

const TABLE_1: BiquadCoefficients = {
	b0: 1.53512485958697,
	b1: -2.69169618940638,
	b2: 1.19839281085285,
	a1: -1.69065929318241,
	a2: 0.73248077421585,
};

const TABLE_2: BiquadCoefficients = {
	b0: 1.0,
	b1: -2.0,
	b2: 1.0,
	a1: -1.99004745483398,
	a2: 0.99007225036621,
};

const TABLE_RATE = 48000;
const SHELF_FREQUENCY = 1681.974450955533;
const SHELF_GAIN_DB = 3.999843853973347;
const SHELF_QUALITY = 0.7071752369554196;
const SHELF_BANDWIDTH_EXPONENT = 0.4996667741545416;
const BILINEAR_SHELF_MINIMUM_RATE = 44100;
const HIGH_PASS_FREQUENCY = 38.13547087602444;
const HIGH_PASS_QUALITY = 0.5003270373238773;

const biquadMagnitudeSquared = (coefficients: BiquadCoefficients, frequency: number, sampleRate: number): number => {
	const omega = (2 * Math.PI * frequency) / sampleRate;
	const cos1 = Math.cos(omega);
	const sin1 = Math.sin(omega);
	const cos2 = Math.cos(2 * omega);
	const sin2 = Math.sin(2 * omega);
	const numeratorReal = coefficients.b0 + coefficients.b1 * cos1 + coefficients.b2 * cos2;
	const numeratorImaginary = coefficients.b1 * sin1 + coefficients.b2 * sin2;
	const denominatorReal = 1 + coefficients.a1 * cos1 + coefficients.a2 * cos2;
	const denominatorImaginary = coefficients.a1 * sin1 + coefficients.a2 * sin2;

	return (
		(numeratorReal * numeratorReal + numeratorImaginary * numeratorImaginary) /
		(denominatorReal * denominatorReal + denominatorImaginary * denominatorImaginary)
	);
};

const bilinearShelfOf = (sampleRate: number): BiquadCoefficients => {
	const kk = Math.tan((Math.PI * SHELF_FREQUENCY) / sampleRate);
	const vh = Math.pow(10, SHELF_GAIN_DB / 20);
	const vb = Math.pow(vh, SHELF_BANDWIDTH_EXPONENT);
	const a0 = 1 + kk / SHELF_QUALITY + kk * kk;

	return {
		b0: (vh + (vb * kk) / SHELF_QUALITY + kk * kk) / a0,
		b1: (2 * (kk * kk - vh)) / a0,
		b2: (vh - (vb * kk) / SHELF_QUALITY + kk * kk) / a0,
		a1: (2 * (kk * kk - 1)) / a0,
		a2: (1 - kk / SHELF_QUALITY + kk * kk) / a0,
	};
};

const matchedShelfOf = (sampleRate: number): BiquadCoefficients => {
	const omega0 = (2 * Math.PI * SHELF_FREQUENCY) / sampleRate;
	const zeta = 1 / (2 * SHELF_QUALITY);
	const a1 = -2 * Math.exp(-zeta * omega0) * Math.cos(Math.sqrt(1 - zeta * zeta) * omega0);
	const a2 = Math.exp(-2 * zeta * omega0);
	const poleA0 = (1 + a1 + a2) ** 2;
	const poleA1 = (1 - a1 + a2) ** 2;
	const poleA2 = -4 * a2;
	const matchFrequency = Math.min(SHELF_FREQUENCY, sampleRate / 4);
	const phi1 = Math.sin((Math.PI * matchFrequency) / sampleRate) ** 2;
	const phi0 = 1 - phi1;
	const phi2 = 4 * phi0 * phi1;
	const zeroB0 = biquadMagnitudeSquared(TABLE_1, 0, TABLE_RATE) * poleA0;
	const zeroB1 = biquadMagnitudeSquared(TABLE_1, sampleRate / 2, TABLE_RATE) * poleA1;
	const zeroB2 =
		(biquadMagnitudeSquared(TABLE_1, matchFrequency, TABLE_RATE) * (poleA0 * phi0 + poleA1 * phi1 + poleA2 * phi2) -
			zeroB0 * phi0 -
			zeroB1 * phi1) /
		phi2;
	const sum = Math.sqrt(zeroB0);
	const alternating = Math.sqrt(zeroB1);
	const outer = (sum + alternating) / 2;
	const b0 = (outer + Math.sqrt(outer * outer + zeroB2)) / 2;

	return { b0, b1: (sum - alternating) / 2, b2: -zeroB2 / (4 * b0), a1, a2 };
};

const highPassA0Of = (sampleRate: number): number => {
	const kk = Math.tan((Math.PI * HIGH_PASS_FREQUENCY) / sampleRate);

	return 1 + kk / HIGH_PASS_QUALITY + kk * kk;
};

export const preFilterCoefficients = (sampleRate: number): BiquadCoefficients => {
	if (sampleRate === TABLE_RATE) return TABLE_1;

	return sampleRate >= BILINEAR_SHELF_MINIMUM_RATE ? bilinearShelfOf(sampleRate) : matchedShelfOf(sampleRate);
};

export const rlbFilterCoefficients = (sampleRate: number): BiquadCoefficients => {
	if (sampleRate === TABLE_RATE) return TABLE_2;

	const kk = Math.tan((Math.PI * HIGH_PASS_FREQUENCY) / sampleRate);
	const a0 = highPassA0Of(sampleRate);
	const gain = highPassA0Of(TABLE_RATE) / a0;

	return {
		b0: gain,
		b1: -2 * gain,
		b2: gain,
		a1: (2 * (kk * kk - 1)) / a0,
		a2: (1 - kk / HIGH_PASS_QUALITY + kk * kk) / a0,
	};
};
