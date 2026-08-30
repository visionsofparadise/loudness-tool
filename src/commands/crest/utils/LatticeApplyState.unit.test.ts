import { describe, expect, it } from "vitest";
import { applyLatticeChannel, applyLatticeSample, LATTICE_ORDER } from "./lattice";
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
		const order = LATTICE_ORDER;
		const row0 = Float64Array.from([0.2, -0.1, 0, 0, 0, 0, 0, 0]);
		const row1 = Float64Array.from([0.6, -0.5, 0, 0, 0, 0, 0, 0]);
		const rows = [row0, row1];
		const signal = new Float64Array(16);

		for (let index = 0; index < signal.length; index++) {
			signal[index] = Math.sin(index * 1.7) + 0.3 * Math.cos(index * 0.9);
		}

		const channel = Float64Array.from(signal);
		const applyState = new LatticeApplyState(trajectoryOf(rows), order, hopSize, 1);

		applyState.apply([channel], channel.length);

		const reference = new Float64Array(signal.length);
		const referenceState = new Float64Array(order);
		const interpolated = new Float64Array(order);

		for (let sample = 0; sample < signal.length; sample++) {
			const framePos = sample / hopSize;
			const frame0 = Math.min(rows.length - 1, Math.max(0, Math.floor(framePos)));
			const frame1 = Math.min(rows.length - 1, frame0 + 1);
			const fraction = framePos - frame0;
			const coefficient0 = rows[frame0] ?? row0;
			const coefficient1 = rows[frame1] ?? row1;

			for (let section = 0; section < order; section++) {
				interpolated[section] =
					(coefficient0[section] ?? 0) + fraction * ((coefficient1[section] ?? 0) - (coefficient0[section] ?? 0));
			}

			reference[sample] = applyLatticeSample(signal[sample] ?? 0, referenceState, interpolated, 1, order);
		}

		for (let index = 0; index < signal.length; index++) {
			expect(channel[index]).toBeCloseTo(reference[index] ?? Number.NaN, 12);
		}

		const row0Only = applyLatticeChannel(signal, row0, 1, order);

		expect(channel[7]).not.toBeCloseTo(row0Only[7] ?? Number.NaN, 12);
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
