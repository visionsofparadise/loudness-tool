import { describe, expect, it } from "vitest";
import { dispersionKernelOf } from "./dispersion";

const circularOf = (kernel: Float64Array): Float64Array => {
	const length = kernel.length;
	const halfWidth = (length - 1) / 2;
	const circular = new Float64Array(length);

	for (let offset = -halfWidth; offset <= halfWidth; offset++) {
		circular[(offset + length) % length] = kernel[offset + halfWidth] ?? 0;
	}

	return circular;
};

const binOf = (circular: Float64Array, bin: number): { magnitude: number; phase: number } => {
	const length = circular.length;
	let real = 0;
	let imaginary = 0;

	for (let position = 0; position < length; position++) {
		const angle = (-2 * Math.PI * bin * position) / length;

		real += (circular[position] ?? 0) * Math.cos(angle);
		imaginary += (circular[position] ?? 0) * Math.sin(angle);
	}

	return { magnitude: Math.hypot(real, imaginary), phase: Math.atan2(imaginary, real) };
};

const statedPhaseOf = (halfWidth: number, bin: number): number => {
	const length = 2 * halfWidth + 1;

	return (Math.PI * halfWidth * bin) / length - (2 * Math.PI * halfWidth * bin * bin) / (length * length);
};

const wrapped = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

describe("dispersionKernelOf", () => {
	it("makes dispersion by zero the frame itself", () => {
		expect(Array.from(dispersionKernelOf(0))).toEqual([1]);
	});

	it("has unit magnitude at every bin and the stated phase up to the half width", () => {
		for (const halfWidth of [1, 2, 5, 13]) {
			const circular = circularOf(dispersionKernelOf(halfWidth));

			for (let bin = 0; bin < circular.length; bin++) {
				expect(binOf(circular, bin).magnitude).toBeCloseTo(1, 10);
			}

			for (let bin = 0; bin <= halfWidth; bin++) {
				expect(wrapped(binOf(circular, bin).phase - statedPhaseOf(halfWidth, bin))).toBeCloseTo(0, 10);
			}
		}
	});

	it("mirrors the bins above the half width as a real signal does", () => {
		const circular = circularOf(dispersionKernelOf(7));
		const length = circular.length;

		for (let bin = 1; bin <= 7; bin++) {
			const lower = binOf(circular, bin);
			const upper = binOf(circular, length - bin);

			expect(upper.magnitude).toBeCloseTo(lower.magnitude, 10);
			expect(wrapped(upper.phase + lower.phase)).toBeCloseTo(0, 10);
		}
	});

	it("preserves a constant and the signal energy", () => {
		const kernel = dispersionKernelOf(9);
		let sum = 0;
		let energy = 0;

		for (const value of kernel) {
			sum += value;
			energy += value * value;
		}

		expect(sum).toBeCloseTo(1, 10);
		expect(energy).toBeCloseTo(1, 10);
	});

	it("reverses the values for a negative step", () => {
		const forward = dispersionKernelOf(6);
		const backward = dispersionKernelOf(-6);

		expect(Array.from(backward)).toEqual(Array.from(forward).reverse());
	});

	it("undoes a step when the opposite step follows it", () => {
		const forward = circularOf(dispersionKernelOf(4));
		const backward = circularOf(dispersionKernelOf(-4));
		const length = forward.length;

		for (let position = 0; position < length; position++) {
			let sum = 0;

			for (let tap = 0; tap < length; tap++) {
				sum += (forward[tap] ?? 0) * (backward[(position - tap + length) % length] ?? 0);
			}

			expect(sum).toBeCloseTo(position === 0 ? 1 : 0, 10);
		}
	});
});
