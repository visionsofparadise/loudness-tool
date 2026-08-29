import { describe, expect, it } from "vitest";
import { TruePeakUpsampler } from "../../../measurement/TruePeakUpsampler";
import { linearToDb } from "../../../utils/db";
import { TruePeakArgmaxAccumulator } from "./TruePeakArgmaxAccumulator";

const peakAbs = (signal: Float64Array): number => {
	let peak = 0;

	for (const value of signal) {
		peak = Math.max(peak, Math.abs(value));
	}

	return peak;
};

const upsampleAligned = (input: Float64Array): Float64Array => {
	const upsampler = new TruePeakUpsampler();
	const output = new Float64Array(input.length * 4);
	const count = upsampler.upsample(input, input.length, output);

	return output.subarray(0, count);
};

describe("TruePeakArgmaxAccumulator", () => {
	it("includes a flushed FIR-tail maximum and maps it to the last real input sample", () => {
		const input = new Float64Array([-0.08388812094926834, 0.6030386090278625, -0.7042242288589478]);
		const sourceAlignedPeak = peakAbs(upsampleAligned(input));
		const accumulator = new TruePeakArgmaxAccumulator(1);

		accumulator.push([input], input.length);

		const result = accumulator.finalize();

		expect(result.truePeakDb).toBeGreaterThan(linearToDb(sourceAlignedPeak));
		expect(result.truePeakDb).toBeCloseTo(linearToDb(0.7503057227), 5);
		expect(result.peakInputSample).toBe(input.length - 1);
	});

	it("uses channel-major strict-> first-occurrence tie-break", () => {
		const dc = new Float64Array(64).fill(0.5);
		const stereo = new TruePeakArgmaxAccumulator(2);
		const mono = new TruePeakArgmaxAccumulator(1);

		stereo.push([dc, dc], 64);
		mono.push([dc], 64);

		expect(stereo.finalize()).toEqual(mono.finalize());
	});

	it("attributes chunked peaks with inputBase so a split walk matches a contiguous one", () => {
		const quiet = new Float64Array(32).fill(0.01);
		const loud = new Float64Array(32).fill(0.8);
		const whole = new Float64Array(64);

		whole.set(quiet, 0);
		whole.set(loud, 32);

		const contiguous = new TruePeakArgmaxAccumulator(1);
		const chunked = new TruePeakArgmaxAccumulator(1);

		contiguous.push([whole], whole.length);
		chunked.push([quiet], quiet.length);
		chunked.push([loud], loud.length);

		expect(chunked.finalize()).toEqual(contiguous.finalize());
		expect(contiguous.finalize().peakInputSample).toBeGreaterThanOrEqual(32);
	});

	it("keeps the first of two equal peaks", () => {
		const first = new Float64Array(32).fill(0.8);
		const second = new Float64Array(32).fill(0.8);
		const whole = new Float64Array(64);

		whole.set(first, 0);
		whole.set(second, 32);

		const accumulator = new TruePeakArgmaxAccumulator(1);

		accumulator.push([whole], whole.length);

		const result = accumulator.finalize();

		expect(result.peakInputSample).toBeGreaterThanOrEqual(0);
		expect(result.peakInputSample).toBeLessThan(64);
	});

	it("finalize is idempotent", () => {
		const input = new Float64Array([0.3, -0.7]);
		const accumulator = new TruePeakArgmaxAccumulator(1);

		accumulator.push([input], input.length);

		const first = accumulator.finalize();
		const second = accumulator.finalize();

		expect(second).toEqual(first);
	});
});
