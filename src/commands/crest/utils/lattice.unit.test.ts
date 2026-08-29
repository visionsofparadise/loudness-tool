import { describe, expect, it } from "vitest";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { linearToDb } from "../../../utils/db";
import { applyLatticeChannel, LATTICE_ORDER, stepDownToReflection } from "./lattice";
import { LatticeApplyState } from "./LatticeApplyState";
import type { ControlTrajectory } from "./trajectory";

const SAMPLE_RATE = 48_000;

const truePeakDb = (channels: ReadonlyArray<Float64Array>): number => {
	const accumulator = new TruePeakAccumulator(channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return linearToDb(accumulator.finalize());
};

const makeDense = (frames: number): Float64Array => {
	const out = new Float64Array(frames);

	for (let index = 0; index < frames; index++) {
		let value = 0;

		for (const frequency of [110, 220, 330, 440, 550, 660, 1500, 3000]) {
			value += Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
		}

		out[index] = (value / 8) * 0.6;
	}

	return out;
};

const staticTrajectory = (poles: ReadonlyArray<number>, frames: number): ControlTrajectory => {
	const order = poles.length;
	const row = Float64Array.from(poles);
	const rows = Array.from({ length: frames }, () => Float64Array.from(row));

	return {
		rows,
		baseRows: rows,
		amountEnv: new Float64Array(frames).fill(1),
		laneCount: order,
		identity: new Float64Array(order),
		transientMask: new Float64Array(frames),
		peakSampleIndex: new Int32Array(frames),
	};
};

const timeVaryingTrajectory = (order: number, frames: number): ControlTrajectory => {
	const rows = Array.from({ length: frames }, (_unused, frame) => {
		const row = new Float64Array(order);

		for (let section = 0; section < order; section++) {
			row[section] = 0.85 * Math.sin(0.7 * frame + 1.3 * section + 0.2);
		}

		return row;
	});

	return {
		rows,
		baseRows: rows,
		amountEnv: new Float64Array(frames).fill(1),
		laneCount: order,
		identity: new Float64Array(order),
		transientMask: new Float64Array(frames),
		peakSampleIndex: new Int32Array(frames),
	};
};

const rms = (signal: Float64Array, from: number, to: number): number => {
	let sum = 0;

	for (let index = from; index < to; index++) {
		sum += (signal[index] ?? 0) * (signal[index] ?? 0);
	}

	return Math.sqrt(sum / (to - from));
};

describe("stepDownToReflection", () => {
	it("recovers reflection coefficients with |kₘ| < 1 from a stable real all-pass denominator", () => {
		const poles = [0.6, -0.4, 0.8, -0.2];
		let polynomial: Array<number> = [1];

		for (const pole of poles) {
			const next = new Array<number>(polynomial.length + 1).fill(0);

			for (let index = 0; index < polynomial.length; index++) {
				next[index] = (next[index] ?? 0) + (polynomial[index] ?? 0);
				next[index + 1] = (next[index + 1] ?? 0) - pole * (polynomial[index] ?? 0);
			}

			polynomial = next;
		}

		const reflection = stepDownToReflection(polynomial);

		expect(reflection.length).toBe(poles.length);

		for (const coefficient of reflection) {
			expect(Number.isFinite(coefficient)).toBe(true);
			expect(Math.abs(coefficient)).toBeLessThan(1);
		}
	});

	it("returns an empty coefficient set for a trivial denominator", () => {
		expect(stepDownToReflection([1]).length).toBe(0);
	});
});

describe("applyLatticeChannel", () => {
	it("a single static section matches the closed-form first-order all-pass", () => {
		const k = 0.6;
		const length = 64;
		const impulse = new Float64Array(length);

		impulse[0] = 1;

		const actual = applyLatticeChannel(impulse, Float64Array.from([k]), 1, 1);
		const expected = new Float64Array(length);

		expected[0] = -k;

		for (let n = 1; n < length; n++) {
			expected[n] = (1 - k * k) * Math.pow(k, n - 1);
		}

		for (let n = 0; n < length; n++) {
			expect(actual[n]).toBeCloseTo(expected[n] ?? Number.NaN, 10);
		}
	});

	it("an all-zero trajectory is exactly an M-sample delay", () => {
		const signal = makeDense(4096);
		const output = applyLatticeChannel(signal, new Float64Array(LATTICE_ORDER), 1, LATTICE_ORDER);

		for (let index = 0; index < LATTICE_ORDER; index++) {
			expect(output[index]).toBe(0);
		}

		for (let index = LATTICE_ORDER; index < signal.length; index++) {
			expect(output[index]).toBeCloseTo(signal[index - LATTICE_ORDER] ?? Number.NaN, 12);
		}

		let differsSomewhere = false;

		for (let index = LATTICE_ORDER; index < signal.length; index++) {
			if (Math.abs((output[index] ?? 0) - (signal[index] ?? 0)) > 1e-4) {
				differsSomewhere = true;
				break;
			}
		}

		expect(differsSomewhere).toBe(true);
		expect(truePeakDb([output])).toBeCloseTo(truePeakDb([signal]), 4);

		const ratio = rms(output, 64, signal.length) / rms(signal, 64, signal.length - LATTICE_ORDER);

		expect(ratio).toBeGreaterThan(0.999);
		expect(ratio).toBeLessThan(1.001);
	});

	it("a static high-order cascade preserves RMS", () => {
		const signal = makeDense(SAMPLE_RATE);
		const output = applyLatticeChannel(
			signal,
			Float64Array.from([0.7, -0.5, 0.85, -0.3, 0.6, -0.75, 0.4, -0.9]),
			1,
			8,
		);
		const ratio = rms(output, 4000, signal.length - 4000) / rms(signal, 4000, signal.length - 4000);

		expect(ratio).toBeGreaterThan(0.999);
		expect(ratio).toBeLessThan(1.001);
	});

	it("output is finite for extreme coefficients", () => {
		const output = applyLatticeChannel(makeDense(8192), new Float64Array(8).fill(5), 1, 8);

		for (const value of output) {
			expect(Number.isFinite(value)).toBe(true);
		}
	});
});

describe("LatticeApplyState time-varying cascade", () => {
	it("preserves RMS when coefficients change every frame", () => {
		const signal = makeDense(SAMPLE_RATE);
		const channel = Float64Array.from(signal);
		const applyState = new LatticeApplyState(timeVaryingTrajectory(8, 120), 8, 512, 1);

		applyState.apply([channel], channel.length);

		const ratio = rms(channel, 4000, signal.length - 4000) / rms(signal, 4000, signal.length - 4000);

		expect(ratio).toBeGreaterThan(0.99);
		expect(ratio).toBeLessThan(1.01);
		expect(Number.isFinite(ratio)).toBe(true);
	});

	it("an all-zero interpolated trajectory is an M-sample delay", () => {
		const signal = makeDense(4096);
		const channel = Float64Array.from(signal);
		const applyState = new LatticeApplyState(
			staticTrajectory(new Array<number>(LATTICE_ORDER).fill(0), 16),
			LATTICE_ORDER,
			512,
			1,
		);

		applyState.apply([channel], channel.length);

		for (let index = LATTICE_ORDER; index < signal.length; index++) {
			expect(channel[index]).toBeCloseTo(signal[index - LATTICE_ORDER] ?? Number.NaN, 12);
		}
	});
});
