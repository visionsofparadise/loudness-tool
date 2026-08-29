import { describe, expect, it } from "vitest";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { linearToDb } from "../../../utils/db";
import { BINDING_DELTA_DB, BINDING_HEADROOM_MIN, classifyWindow, isBindingPeak } from "./binding";
import { measureFrameTruePeakDb } from "./objective";

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 2048;
const HOP_SIZE = FRAME_SIZE / 4;

const windowTruePeakDb = (channels: ReadonlyArray<Float64Array>): number => measureFrameTruePeakDb(channels);

const referenceTruePeakDb = (channels: ReadonlyArray<Float64Array>): number => {
	const accumulator = new TruePeakAccumulator(channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return linearToDb(accumulator.finalize());
};

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

const makePreClipped = (frames: number, sampleRate: number): Float64Array => {
	const out = new Float64Array(frames);

	for (let index = 0; index < frames; index++) {
		const value = Math.sin((2 * Math.PI * 200 * index) / sampleRate) * 2;

		out[index] = Math.max(-1, Math.min(1, value));
	}

	return out;
};

const makeDense = (frames: number, sampleRate: number): Float64Array => {
	const out = new Float64Array(frames);

	for (let index = 0; index < frames; index++) {
		let value = 0;

		for (const frequency of [110, 220, 330, 440, 550, 660, 1500, 3000]) {
			value += Math.sin((2 * Math.PI * frequency * index) / sampleRate);
		}

		out[index] = (value / 8) * 0.6;
	}

	return out;
};

const makeImpulseTrain = (frames: number, period: number): Float64Array => {
	const out = new Float64Array(frames);
	let state = 7 >>> 0;

	for (let index = 0; index < frames; index++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		out[index] = (state / 0xffffffff - 0.5) * 0.002;
	}

	for (let index = 0; index < frames; index += period) {
		out[index] = index % (2 * period) === 0 ? 0.95 : -0.95;
	}

	return out;
};

const classifySignal = (signal: Float64Array, globalTruePeakDb: number): Array<ReturnType<typeof classifyWindow>> => {
	const count = signal.length < FRAME_SIZE ? 0 : Math.floor((signal.length - FRAME_SIZE) / HOP_SIZE) + 1;
	const out: Array<ReturnType<typeof classifyWindow>> = [];

	for (let frame = 0; frame < count; frame++) {
		out.push(classifyWindow([signal.subarray(frame * HOP_SIZE, frame * HOP_SIZE + FRAME_SIZE)], globalTruePeakDb));
	}

	return out;
};

describe("binding constants", () => {
	it("are the declared glue values", () => {
		expect(BINDING_DELTA_DB).toBe(3);
		expect(BINDING_HEADROOM_MIN).toBe(0.5);
	});
});

describe("classifyWindow", () => {
	it("flags a high-crest window at the global true peak as binding", () => {
		const window = new Float64Array(FRAME_SIZE);

		for (let index = 0; index < FRAME_SIZE; index++) {
			window[index] = Math.sin((2 * Math.PI * 200 * index) / SAMPLE_RATE) * 0.1;
		}

		window[1234] = -0.8;

		const globalTpDb = windowTruePeakDb([window]);
		const result = classifyWindow([window], globalTpDb);

		expect(result.binding).toBe(true);
		expect(result.peakIndex).toBe(1234);
		expect(result.peakValue).toBeCloseTo(-0.8, 12);
		expect(result.peakMagnitude).toBeCloseTo(0.8, 12);
		expect(result.headroom).toBeGreaterThan(BINDING_HEADROOM_MIN);
		expect(result.frameTruePeakDb).toBeCloseTo(windowTruePeakDb([window]), 12);
	});

	it("flags a window more than BINDING_DELTA_DB below the global peak as non-binding", () => {
		const window = new Float64Array(FRAME_SIZE);

		window[10] = 0.1;

		const result = classifyWindow([window], linearToDb(1), false);

		expect(result.binding).toBe(false);
		expect(result.peakIndex).toBe(10);
		expect(result.peakMagnitude).toBeCloseTo(0.1, 12);
	});

	it("force-binds the global-4×-TP frame when proximity fails", () => {
		const window = makeHeadroomBearing(FRAME_SIZE, SAMPLE_RATE);
		const farGlobalDb = windowTruePeakDb([window]) + 50;
		const notForced = classifyWindow([window], farGlobalDb, false);
		const forced = classifyWindow([window], farGlobalDb, true);

		expect(notForced.binding).toBe(false);
		expect(forced.headroom).toBeGreaterThan(BINDING_HEADROOM_MIN);
		expect(forced.binding).toBe(true);
	});

	it("a zero-headroom window stays unbound even when force-flagged", () => {
		const clipped = makePreClipped(FRAME_SIZE, SAMPLE_RATE);
		const forced = classifyWindow([clipped], windowTruePeakDb([clipped]), true);

		expect(forced.headroom).toBe(0);
		expect(forced.binding).toBe(false);
	});

	it("is inclusive on the proximity boundary", () => {
		const window = new Float64Array(FRAME_SIZE);

		window[0] = 0.5;

		const ownTpDb = windowTruePeakDb([window]);
		const onEdge = classifyWindow([window], ownTpDb + BINDING_DELTA_DB, false);
		const justOver = classifyWindow([window], ownTpDb + BINDING_DELTA_DB + 0.01, false);

		expect(onEdge.headroom).toBeGreaterThan(BINDING_HEADROOM_MIN);
		expect(onEdge.binding).toBe(true);
		expect(justOver.binding).toBe(false);
	});

	it("classifies a silent / empty window as non-binding", () => {
		expect(classifyWindow([new Float64Array(FRAME_SIZE)], linearToDb(0.5)).binding).toBe(false);

		const empty = classifyWindow([new Float64Array(0)], linearToDb(0.5));

		expect(empty.binding).toBe(false);
		expect(empty.peakIndex).toBe(-1);
		expect(empty.peakMagnitude).toBe(0);
		expect(empty.headroom).toBe(0);
	});
});

describe("isBindingPeak", () => {
	it("is the exact (headroom AND (proximity OR force-bind)) predicate", () => {
		const window = makeHeadroomBearing(FRAME_SIZE, SAMPLE_RATE);
		const ownTpDb = windowTruePeakDb([window]);
		const proxBind = classifyWindow([window], ownTpDb, false);

		expect(isBindingPeak(proxBind.frameTruePeakDb, proxBind.headroom, ownTpDb, false)).toBe(proxBind.binding);
		expect(proxBind.binding).toBe(true);

		const farDb = ownTpDb + 50;
		const farClassify = classifyWindow([window], farDb, false);

		expect(isBindingPeak(farClassify.frameTruePeakDb, farClassify.headroom, farDb, false)).toBe(farClassify.binding);
		expect(farClassify.binding).toBe(false);

		const forced = classifyWindow([window], farDb, true);

		expect(isBindingPeak(forced.frameTruePeakDb, forced.headroom, farDb, true)).toBe(forced.binding);
		expect(forced.binding).toBe(true);
		expect(isBindingPeak(linearToDb(0.5), BINDING_HEADROOM_MIN, linearToDb(0.5), false)).toBe(false);
		expect(isBindingPeak(linearToDb(0.5), BINDING_HEADROOM_MIN + 1e-6, linearToDb(0.5), false)).toBe(true);
		expect(isBindingPeak(linearToDb(1), 0, linearToDb(1), true)).toBe(false);
	});
});

describe("the gate on fixtures", () => {
	const FRAMES = SAMPLE_RATE;

	it("binds impulse-train peak windows and leaves quiet runs unbound", () => {
		const signal = makeImpulseTrain(FRAMES, 4800);
		const windows = classifySignal(signal, referenceTruePeakDb([signal]));
		const bindingCount = windows.filter((window) => window.binding).length;

		expect(bindingCount).toBeGreaterThan(0);
		expect(bindingCount).toBeLessThan(windows.length);

		for (const window of windows) {
			if (window.binding) {
				expect(window.peakMagnitude).toBeGreaterThan(0.5);
			}
		}
	});

	it("binds headroom-bearing windows", () => {
		const signal = makeHeadroomBearing(FRAMES, SAMPLE_RATE);
		const windows = classifySignal(signal, referenceTruePeakDb([signal]));

		expect(windows.some((window) => window.binding)).toBe(true);
		expect(windows.every((window) => window.headroom > BINDING_HEADROOM_MIN)).toBe(true);
	});

	it("leaves an already-limited fixture unbound", () => {
		const windows = classifySignal(makePreClipped(FRAMES, SAMPLE_RATE), linearToDb(1));

		expect(windows.every((window) => window.headroom === 0)).toBe(true);
		expect(windows.every((window) => !window.binding)).toBe(true);
	});

	it("leaves a mildly-diffuse fixture unbound", () => {
		const signal = makeDense(FRAMES, SAMPLE_RATE);
		const windows = classifySignal(signal, referenceTruePeakDb([signal]));

		expect(windows.some((window) => window.binding)).toBe(false);
		expect(windows.every((window) => window.headroom < BINDING_HEADROOM_MIN)).toBe(true);
	});
});
