import { describe, expect, it } from "vitest";
import { betaForBand, designDispersionAllpass, poleRadius, schroederTargetToDelay } from "./dispersion";
import { stepDownToReflection } from "./lattice";

const makeDenseMagnitude = (bins: number): Float64Array => {
	const mag = new Float64Array(bins);

	for (let bin = 0; bin < bins; bin++) {
		mag[bin] = 1 / (1 + bin / 8);
	}

	return mag;
};

const sectionGroupDelay = (rho: number, theta: number, omega: number): number =>
	(1 - rho * rho) / (1 + rho * rho - 2 * rho * Math.cos(omega - theta));

const rawAllpassPhase = (denominator: Float64Array, w: number): number => {
	let re = 0;
	let im = 0;

	for (let k = 0; k < denominator.length; k++) {
		const d = denominator[k] ?? 0;

		re += d * Math.cos(-k * w);
		im += d * Math.sin(-k * w);
	}

	const m = denominator.length - 1;

	return -2 * Math.atan2(im, re) - m * w;
};

const polyAllpassGroupDelay = (denominator: Float64Array, omega: number): number => {
	const h = 1e-5;
	const pa = rawAllpassPhase(denominator, omega - h);
	let pb = rawAllpassPhase(denominator, omega + h);

	while (pb - pa > Math.PI) {
		pb -= 2 * Math.PI;
	}

	while (pb - pa < -Math.PI) {
		pb += 2 * Math.PI;
	}

	return -(pb - pa) / (2 * h);
};

const halfBandGroupDelayArea = (denominator: Float64Array, steps = 20_000): number => {
	let prev = rawAllpassPhase(denominator, 0);
	let total = prev;

	for (let i = 1; i <= steps; i++) {
		const w = (Math.PI * i) / steps;
		let p = rawAllpassPhase(denominator, w);

		while (p - prev > Math.PI) {
			p -= 2 * Math.PI;
		}

		while (p - prev < -Math.PI) {
			p += 2 * Math.PI;
		}

		total += p - prev;
		prev = p;
	}

	return rawAllpassPhase(denominator, 0) - total;
};

describe("betaForBand", () => {
	it("is a constant moderate β in (0, 1) for every band", () => {
		for (let band = 0; band < 16; band++) {
			const beta = betaForBand(band);

			expect(beta).toBeGreaterThan(0);
			expect(beta).toBeLessThan(1);
		}
	});
});

describe("poleRadius", () => {
	it("matches the exact closed form ρ = η − √(η²−1)", () => {
		const beta = 0.5;
		const delta = 0.4;
		const eta = (1 - beta * Math.cos(delta)) / (1 - beta);
		const expected = eta - Math.sqrt(eta * eta - 1);

		expect(poleRadius(delta, beta)).toBeCloseTo(Math.min(0.95, expected), 12);
	});

	it("a narrower band ⇒ a larger pole radius", () => {
		expect(poleRadius(0.05, 0.5)).toBeGreaterThan(poleRadius(0.5, 0.5));
	});

	it("the Eq. 12 and Eq. 10 branches are continuous at the Δ switch", () => {
		const beta = 0.5;

		expect(poleRadius(1e-3 * 0.999, beta)).toBeCloseTo(poleRadius(1e-3 * 1.001, beta), 4);

		const dMod = 0.3;
		const etaMod = (1 - beta * Math.cos(dMod)) / (1 - beta);
		const exactMod = etaMod - Math.sqrt(etaMod * etaMod - 1);

		expect(poleRadius(dMod, beta)).toBeCloseTo(Math.min(0.95, exactMod), 12);
	});

	it("is clamped strictly inside the unit circle", () => {
		expect(poleRadius(1e-9, 0.99)).toBeLessThanOrEqual(0.95);
		expect(poleRadius(1e-9, 0.99)).toBeGreaterThanOrEqual(0);
	});
});

describe("schroederTargetToDelay", () => {
	it("yields a non-negative group delay", () => {
		const delay = schroederTargetToDelay(makeDenseMagnitude(513), 1);

		expect(delay.length).toBe(513);

		for (const value of delay) {
			expect(value).toBeGreaterThanOrEqual(0);
		}
	});

	it("scales linearly with the peak-priority amount", () => {
		const mag = makeDenseMagnitude(513);
		const full = schroederTargetToDelay(mag, 1);
		const half = schroederTargetToDelay(mag, 0.5);
		const zero = schroederTargetToDelay(mag, 0);

		for (let bin = 0; bin < full.length; bin++) {
			expect(half[bin]).toBeCloseTo((full[bin] ?? 0) * 0.5, 12);
			expect(zero[bin]).toBe(0);
		}
	});
});

describe("designDispersionAllpass", () => {
	it("an identity target yields the trivial all-pass D(z) = 1", () => {
		const { denominator, poles } = designDispersionAllpass(new Float64Array(513), 8);

		expect(Array.from(denominator)).toEqual([1]);
		expect(poles.length).toBe(0);
	});

	it("produces a monic, real, stable D(z) whose step-down kₘ satisfy |kₘ| < 1", () => {
		const delay = schroederTargetToDelay(makeDenseMagnitude(1025), 1);
		const { denominator } = designDispersionAllpass(delay, 8);

		expect(denominator[0]).toBe(1);
		expect(denominator.length).toBeLessThanOrEqual(9);

		for (const coefficient of denominator) {
			expect(Number.isFinite(coefficient)).toBe(true);
		}

		const reflection = stepDownToReflection(denominator);

		expect(reflection.length).toBeGreaterThan(0);

		for (const k of reflection) {
			expect(Number.isFinite(k)).toBe(true);
			expect(Math.abs(k)).toBeLessThan(1);
		}
	});

	it("a single-pole design reproduces its own Eq. 3 group delay", () => {
		const delay = new Float64Array(1025).fill(1);
		const { denominator, poles } = designDispersionAllpass(delay, 1);

		expect(poles.length).toBe(1);

		const { rho, theta } = poles[0] ?? { rho: 0, theta: 0 };

		expect(theta).toBeCloseTo(0, 12);

		for (const omega of [0.2, 0.8, 1.5, 2.5]) {
			expect(polyAllpassGroupDelay(denominator, omega)).toBeCloseTo(sectionGroupDelay(rho, theta, omega), 2);
		}
	});

	it("the cascade group delay integrates to degree·π", () => {
		const delay = new Float64Array(2049);

		for (let bin = 0; bin < delay.length; bin++) {
			delay[bin] = 3 + 2 * Math.cos((4 * Math.PI * bin) / delay.length);
		}

		const { denominator } = designDispersionAllpass(delay, 8);
		const degree = denominator.length - 1;

		expect(degree).toBeGreaterThan(0);
		expect(halfBandGroupDelayArea(denominator)).toBeCloseTo(degree * Math.PI, 0);
	});

	it("a peakier target yields a higher-order, larger-delay design than a flat one", () => {
		const bins = 1025;
		const peaky = new Float64Array(bins);
		const mild = new Float64Array(bins);

		for (let bin = 0; bin < bins; bin++) {
			peaky[bin] = bin < 120 ? 12 : 0.05;
			mild[bin] = 0.4;
		}

		const dPeaky = designDispersionAllpass(peaky, 8);
		const dMild = designDispersionAllpass(mild, 8);

		expect(dPeaky.denominator.length).toBeGreaterThan(1);
		expect(halfBandGroupDelayArea(dPeaky.denominator)).toBeGreaterThan(halfBandGroupDelayArea(dMild.denominator));
		expect(dPeaky.denominator.length - 1).toBeLessThanOrEqual(8);
	});
});
