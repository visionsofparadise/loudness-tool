// eslint-disable-next-line comment-rules/no-restricted-comments
// Abel & Smith (2006), DAFx-06 §2–3 Eq. (1)–(12).
// eslint-disable-next-line comment-rules/no-restricted-comments
// (a) Schroeder→δ and (b) β schedule are project glue, not Abel & Smith.

import { schroederTargetPhase } from "./schroeder";

// eslint-disable-next-line comment-rules/no-restricted-comments
// RMV §III |k|<1 stability clamp
const MAX_POLE_RADIUS = 0.95;

export const betaForBand = (_bandIndex: number): number => 0.5;

export const schroederTargetToDelay = (magnitude: ArrayLike<number>, amount = 1): Float64Array => {
	const binCount = magnitude.length;
	const delay = new Float64Array(binCount);

	if (binCount < 2) {
		return delay;
	}

	const phase = schroederTargetPhase(magnitude);
	const dOmega = Math.PI / (binCount - 1);
	const scale = Math.max(0, Math.min(1, amount));

	for (let bin = 0; bin < binCount; bin++) {
		const lo = bin === 0 ? 0 : bin - 1;
		const hi = bin === binCount - 1 ? binCount - 1 : bin + 1;
		const dPhi = (phase[hi] ?? 0) - (phase[lo] ?? 0);
		const span = (hi - lo) * dOmega;
		const tau = span > 0 ? -dPhi / span : 0;

		delay[bin] = scale * Math.max(0, tau);
	}

	return delay;
};

// eslint-disable-next-line comment-rules/no-restricted-comments
// Abel & Smith Eq. (10)–(12)
export const poleRadius = (halfWidth: number, beta: number): number => {
	const delta = Math.max(0, halfWidth);
	const betaClamped = Math.max(1e-6, Math.min(1 - 1e-6, beta));
	let rho: number;

	if (delta < 1e-3) {
		rho = 1 - Math.sqrt(betaClamped / (1 - betaClamped)) * delta;
	} else {
		const eta = (1 - betaClamped * Math.cos(delta)) / (1 - betaClamped);

		rho = eta - Math.sqrt(Math.max(0, eta * eta - 1));
	}

	if (!Number.isFinite(rho)) {
		return 0;
	}

	return Math.max(0, Math.min(MAX_POLE_RADIUS, rho));
};

export const designDispersionAllpass = (
	delay: ArrayLike<number>,
	order: number,
): { denominator: Float64Array; poles: Array<{ rho: number; theta: number }> } => {
	const binCount = delay.length;
	const poles: Array<{ rho: number; theta: number }> = [];

	if (binCount < 2 || order <= 0) {
		return { denominator: Float64Array.from([1]), poles };
	}

	const dOmega = Math.PI / (binCount - 1);
	let rawHalfArea = 0;

	for (let bin = 0; bin < binCount - 1; bin++) {
		rawHalfArea += 0.5 * ((delay[bin] ?? 0) + (delay[bin + 1] ?? 0)) * dOmega;
	}

	let naturalOrder = Math.round(rawHalfArea / Math.PI);

	if (naturalOrder < 0) {
		naturalOrder = 0;
	}

	const bandOrder = Math.min(order, naturalOrder);
	const scaled = new Float64Array(binCount);
	let constantDelay = 0;

	if (bandOrder <= 0) {
		return { denominator: Float64Array.from([1]), poles };
	}

	if (rawHalfArea > bandOrder * Math.PI && rawHalfArea > 0) {
		const areaScale = (bandOrder * Math.PI) / rawHalfArea;

		for (let bin = 0; bin < binCount; bin++) {
			scaled[bin] = areaScale * (delay[bin] ?? 0);
		}
	} else {
		for (let bin = 0; bin < binCount; bin++) {
			scaled[bin] = delay[bin] ?? 0;
		}

		constantDelay = Math.max(0, (bandOrder * Math.PI - rawHalfArea) / Math.PI);
	}

	const omegaAt = (bin: number): number => bin * dOmega;
	const deltaAt = (bin: number): number => (scaled[bin] ?? 0) + constantDelay;
	const cumulative = new Float64Array(binCount);

	for (let bin = 1; bin < binCount; bin++) {
		cumulative[bin] = (cumulative[bin - 1] ?? 0) + 0.5 * (deltaAt(bin) + deltaAt(bin - 1)) * dOmega;
	}

	const totalArea = cumulative[binCount - 1] ?? 0;
	let maxTau = 0;

	for (let bin = 0; bin < binCount; bin++) {
		maxTau = Math.max(maxTau, deltaAt(bin));
	}

	if (totalArea <= 0 || maxTau <= 0) {
		return { denominator: Float64Array.from([1]), poles };
	}

	const omegaAtArea = (target: number): number => {
		if (target <= 0) {
			return 0;
		}

		if (target >= totalArea) {
			return Math.PI;
		}

		let bin = 1;

		while (bin < binCount && (cumulative[bin] ?? 0) < target) {
			bin++;
		}

		const aLo = cumulative[bin - 1] ?? 0;
		const aHi = cumulative[bin] ?? aLo;
		const frac = aHi > aLo ? (target - aLo) / (aHi - aLo) : 0;

		return omegaAt(bin - 1) + frac * dOmega;
	};

	let polynomial: Array<number> = [1];
	let degree = 0;
	let bandIndex = 0;

	const convolve = (factor: ReadonlyArray<number>): void => {
		const next = new Array<number>(polynomial.length + factor.length - 1).fill(0);

		for (let polynomialIndex = 0; polynomialIndex < polynomial.length; polynomialIndex++) {
			for (let factorIndex = 0; factorIndex < factor.length; factorIndex++) {
				next[polynomialIndex + factorIndex] =
					(next[polynomialIndex + factorIndex] ?? 0) +
					(polynomial[polynomialIndex] ?? 0) * (factor[factorIndex] ?? 0);
			}
		}

		polynomial = next;
	};

	{
		const omegaHi = omegaAtArea(Math.PI);
		const rho = poleRadius(omegaHi, betaForBand(bandIndex));

		poles.push({ rho, theta: 0 });
		convolve([1, -rho]);
		degree += 1;
		bandIndex += 1;
	}

	let areaCursor = Math.PI;
	const EPS = 1e-6;

	while (bandOrder * Math.PI - areaCursor >= 2 * Math.PI - EPS && degree + 2 <= order) {
		const omegaLo = omegaAtArea(areaCursor);
		const omegaHi = omegaAtArea(areaCursor + 2 * Math.PI);
		const theta = (omegaLo + omegaHi) / 2;
		const halfWidth = (omegaHi - omegaLo) / 2;
		const rho = poleRadius(halfWidth, betaForBand(bandIndex));

		poles.push({ rho, theta });
		convolve([1, -2 * rho * Math.cos(theta), rho * rho]);
		degree += 2;
		bandIndex += 1;
		areaCursor += 2 * Math.PI;
	}

	if (bandOrder * Math.PI - areaCursor >= Math.PI - EPS && degree + 1 <= order) {
		const omegaLo = omegaAtArea(areaCursor);
		const rho = poleRadius(Math.PI - omegaLo, betaForBand(bandIndex));

		poles.push({ rho, theta: Math.PI });
		convolve([1, rho]);
	}

	const denominator = new Float64Array(polynomial.length);

	for (let index = 0; index < polynomial.length; index++) {
		denominator[index] = polynomial[index] ?? 0;
	}

	denominator[0] = 1;

	return { denominator, poles };
};
