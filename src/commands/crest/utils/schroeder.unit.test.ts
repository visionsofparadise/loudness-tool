import { describe, expect, it } from "vitest";
import { relativePower, schroederTargetPhase } from "./schroeder";

const referencePhase = (power: ReadonlyArray<number>, phi1: number): Array<number> => {
	const binCount = power.length;
	const out: Array<number> = [];

	for (let oneBasedI = 1; oneBasedI <= binCount; oneBasedI++) {
		let sum = 0;

		for (let oneBasedJ = 1; oneBasedJ <= oneBasedI - 1; oneBasedJ++) {
			sum += (binCount - oneBasedJ) * (power[oneBasedJ - 1] ?? 0);
		}

		out.push(phi1 - 2 * Math.PI * sum);
	}

	return out;
};

describe("relativePower", () => {
	it("normalizes |X|² so the bins sum to 1", () => {
		const power = relativePower([1, 2, 3, 4]);

		expect(power.length).toBe(4);
		expect(power[0]).toBeCloseTo(1 / 30, 12);
		expect(power[1]).toBeCloseTo(4 / 30, 12);
		expect(power[2]).toBeCloseTo(9 / 30, 12);
		expect(power[3]).toBeCloseTo(16 / 30, 12);

		let total = 0;

		for (const value of power) {
			total += value;
		}

		expect(total).toBeCloseTo(1, 12);
	});

	it("returns a uniform distribution for a silent frame", () => {
		const power = relativePower([0, 0, 0, 0, 0]);

		for (const value of power) {
			expect(value).toBeCloseTo(1 / 5, 12);
		}
	});

	it("returns an empty array for an empty spectrum", () => {
		expect(relativePower([]).length).toBe(0);
	});
});

describe("schroederTargetPhase", () => {
	it("matches the transcribed Eq. (2) closed form on a known non-flat spectrum", () => {
		const magnitude = [0.5, 2, 1, 3, 0.25, 1.5];
		const phi1 = 0.37;
		const power = relativePower(magnitude);
		const expected = referencePhase(Array.from(power), phi1);
		const actual = schroederTargetPhase(magnitude, phi1);

		expect(actual.length).toBe(magnitude.length);

		for (let bin = 0; bin < magnitude.length; bin++) {
			expect(actual[bin]).toBeCloseTo(expected[bin] ?? Number.NaN, 12);
		}
	});

	it("bin 0 has an empty inner sum, so its phase is exactly Φ_1", () => {
		const phase = schroederTargetPhase([3, 1, 4, 1, 5], 1.234);

		expect(phase[0]).toBeCloseTo(1.234, 12);
	});

	it("reduces to quadratic curvature +2π/k for a flat spectrum", () => {
		const binCount = 16;
		const phase = schroederTargetPhase(new Array<number>(binCount).fill(1), 0);
		const curvature = (2 * Math.PI) / binCount;

		for (let bin = 1; bin < binCount - 1; bin++) {
			const secondDifference = (phase[bin + 1] ?? 0) - 2 * (phase[bin] ?? 0) + (phase[bin - 1] ?? 0);

			expect(secondDifference).toBeCloseTo(curvature, 12);
		}
	});

	it("is spectrum-adaptive — a non-flat spectrum is not the flat quadratic", () => {
		const binCount = 16;
		const flat = new Array<number>(binCount).fill(1);
		const peaky = new Array<number>(binCount).fill(0.01);

		peaky[3] = 5;
		peaky[10] = 3;

		const flatPhase = schroederTargetPhase(flat, 0);
		const peakyPhase = schroederTargetPhase(peaky, 0);
		let maxDelta = 0;

		for (let bin = 0; bin < binCount; bin++) {
			maxDelta = Math.max(maxDelta, Math.abs((flatPhase[bin] ?? 0) - (peakyPhase[bin] ?? 0)));
		}

		expect(maxDelta).toBeGreaterThan(1);
	});

	it("returns an empty array for an empty spectrum", () => {
		expect(schroederTargetPhase([], 0).length).toBe(0);
	});
});
