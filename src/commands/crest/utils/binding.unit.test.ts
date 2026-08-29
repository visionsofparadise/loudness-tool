import { describe, expect, it } from "vitest";
import { linearToDb } from "../../../utils/db";
import { BINDING_DELTA_DB, BINDING_HEADROOM_MIN, isBindingPeak, peakPriorityAmount } from "./binding";
import { measureFrameTruePeakDb } from "./objective";

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 2048;

const makeHeadroomBearing = (frames: number, sampleRate: number, f0 = 100, harmonics = 40): Float64Array => {
	const out = new Float64Array(frames);
	let peak = 0;

	for (let index = 0; index < frames; index++) {
		let value = 0;

		for (let harmonic = 1; harmonic <= harmonics; harmonic++) {
			value += Math.cos((2 * Math.PI * harmonic * f0 * index) / sampleRate);
		}

		out[index] = value;
		peak = Math.max(peak, Math.abs(value));
	}

	if (peak > 0) {
		for (let index = 0; index < frames; index++) {
			out[index] = ((out[index] ?? 0) / peak) * 0.9;
		}
	}

	return out;
};

describe("binding constants", () => {
	it("are the declared glue values", () => {
		expect(BINDING_DELTA_DB).toBe(3);
		expect(BINDING_HEADROOM_MIN).toBe(0.5);
	});
});

describe("isBindingPeak", () => {
	it("is the exact (headroom AND (proximity OR force-bind)) predicate", () => {
		const window = makeHeadroomBearing(FRAME_SIZE, SAMPLE_RATE);
		const ownTpDb = measureFrameTruePeakDb([window]);
		const headroom = peakPriorityAmount(window, 0, window.length);

		expect(headroom).toBeGreaterThan(BINDING_HEADROOM_MIN);
		expect(isBindingPeak(ownTpDb, headroom, ownTpDb, false)).toBe(true);
		expect(isBindingPeak(ownTpDb, headroom, ownTpDb + 50, false)).toBe(false);
		expect(isBindingPeak(ownTpDb, headroom, ownTpDb + 50, true)).toBe(true);
		expect(isBindingPeak(linearToDb(0.5), BINDING_HEADROOM_MIN, linearToDb(0.5), false)).toBe(false);
		expect(isBindingPeak(linearToDb(0.5), BINDING_HEADROOM_MIN + 1e-6, linearToDb(0.5), false)).toBe(true);
		expect(isBindingPeak(linearToDb(1), 0, linearToDb(1), true)).toBe(false);
	});

	it("is inclusive on the proximity boundary", () => {
		const window = new Float64Array(FRAME_SIZE);

		window[0] = 0.5;

		const ownTpDb = measureFrameTruePeakDb([window]);
		const headroom = peakPriorityAmount(window, 0, window.length);

		expect(headroom).toBeGreaterThan(BINDING_HEADROOM_MIN);
		expect(isBindingPeak(ownTpDb, headroom, ownTpDb + BINDING_DELTA_DB, false)).toBe(true);
		expect(isBindingPeak(ownTpDb, headroom, ownTpDb + BINDING_DELTA_DB + 0.01, false)).toBe(false);
	});
});
