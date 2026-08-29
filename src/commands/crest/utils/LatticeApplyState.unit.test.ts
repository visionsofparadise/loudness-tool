import { describe, expect, it } from "vitest";
import { applyLatticeChannel, LATTICE_ORDER } from "./lattice";
import { LatticeApplyState } from "./LatticeApplyState";
import type { ControlTrajectory } from "./trajectory";

const trajectoryOf = (rows: ReadonlyArray<Float64Array>): ControlTrajectory => ({
	rows,
	baseRows: rows,
	amountEnv: new Float64Array(rows.length).fill(1),
	laneCount: rows[0]?.length ?? 0,
	identity: new Float64Array(rows[0]?.length ?? 0),
	transientMask: new Float64Array(rows.length),
	peakSampleIndex: new Int32Array(rows.length),
});

describe("LatticeApplyState", () => {
	it("interpolates coefficients between adjacent frames", () => {
		const hopSize = 4;
		const row0 = Float64Array.from([0.2, -0.1, 0, 0, 0, 0, 0, 0]);
		const row1 = Float64Array.from([0.6, -0.5, 0, 0, 0, 0, 0, 0]);
		const signal = new Float64Array(8);

		signal[0] = 1;

		const channel = Float64Array.from(signal);
		const applyState = new LatticeApplyState(trajectoryOf([row0, row1]), LATTICE_ORDER, hopSize, 1);

		applyState.apply([channel], channel.length);

		const expectedStart = applyLatticeChannel(signal, row0, 1, LATTICE_ORDER);

		expect(channel[0]).toBeCloseTo(expectedStart[0] ?? Number.NaN, 12);

		const midRow = Float64Array.from([0.4, -0.3, 0, 0, 0, 0, 0, 0]);
		const midInput = new Float64Array(8);

		midInput[2] = 1;

		const midChannel = Float64Array.from(midInput);
		const midApplyState = new LatticeApplyState(trajectoryOf([row0, row1]), LATTICE_ORDER, hopSize, 1);

		midApplyState.apply([midChannel], midChannel.length);

		const expectedMid = applyLatticeChannel(midInput, midRow, 1, LATTICE_ORDER);

		expect(midChannel[2]).toBeCloseTo(expectedMid[2] ?? Number.NaN, 12);
	});

	it("an all-zero trajectory is exactly an M-sample delay", () => {
		const length = 64;
		const signal = new Float64Array(length);

		for (let index = 0; index < length; index++) {
			signal[index] = Math.sin(index * 0.2);
		}

		const zeros = new Float64Array(LATTICE_ORDER);
		const channel = Float64Array.from(signal);
		const applyState = new LatticeApplyState(trajectoryOf([zeros, zeros]), LATTICE_ORDER, 8, 1);

		applyState.apply([channel], channel.length);

		for (let index = 0; index < LATTICE_ORDER; index++) {
			expect(channel[index]).toBe(0);
		}

		for (let index = LATTICE_ORDER; index < length; index++) {
			expect(channel[index]).toBeCloseTo(signal[index - LATTICE_ORDER] ?? Number.NaN, 12);
		}
	});
});
