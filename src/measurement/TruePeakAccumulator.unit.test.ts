import { describe, expect, it } from "vitest";
import { TruePeakAccumulator } from "./TruePeakAccumulator";

const generateSine = (
	frequency: number,
	amplitude: number,
	sampleRate: number,
	durationSeconds: number,
): Float64Array => {
	const length = Math.floor(sampleRate * durationSeconds);
	const buffer = new Float64Array(length);

	for (let index = 0; index < length; index++) {
		buffer[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
	}

	return buffer;
};

const measure = (channels: ReadonlyArray<Float64Array>): number => {
	const accumulator = new TruePeakAccumulator(channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return accumulator.finalize();
};

describe("TruePeakAccumulator", () => {
	it("includes the raw sample peak when every FIR phase is below it", () => {
		const impulse = new Float64Array([1]);

		expect(measure([impulse])).toBe(1);
	});

	it("includes a maximum that occurs only in the flushed FIR tail", () => {
		const input = new Float64Array([-0.08388812094926834, 0.6030386090278625, -0.7042242288589478]);

		expect(Math.abs(measure([input]) - 0.7503057227)).toBeLessThan(1e-6);
	});

	it("measures a steady 997 Hz sine at or above its sample peak", () => {
		const sine = generateSine(997, 1, 48000, 1);

		expect(measure([sine])).toBeGreaterThanOrEqual(1 - 1e-3);
	});

	it("takes one maximum across all channels", () => {
		const left = new Float64Array(1000).fill(0.3);
		const right = new Float64Array(1000).fill(0.7);
		const result = measure([left, right]);

		expect(result).toBeGreaterThanOrEqual(0.7);
		expect(result).toBeLessThan(0.8);
	});

	it("arbitrary input chunks match a whole-buffer measurement", () => {
		const input = generateSine(997, 0.8, 48000, 1);
		const whole = measure([input]);
		const chunked = new TruePeakAccumulator(1);
		let offset = 0;

		for (const end of [1, 19, 4096, 11003, 32001, input.length]) {
			chunked.push([input.subarray(offset, end)], end - offset);
			offset = end;
		}

		expect(Math.abs(chunked.finalize() - whole)).toBeLessThan(1e-6);
	});

	it("finalize is idempotent and rejects every later push", () => {
		const accumulator = new TruePeakAccumulator(1);

		accumulator.push([new Float64Array([0.5])], 1);

		const first = accumulator.finalize();

		expect(accumulator.finalize()).toBe(first);
		expect(() => accumulator.push([new Float64Array([0.25])], 1)).toThrow("push after finalize");
		expect(() => accumulator.push([new Float64Array(0)], 0)).toThrow("push after finalize");
	});

	it("empty and silent finite inputs return zero", () => {
		const empty = new TruePeakAccumulator(1);

		expect(empty.finalize()).toBe(0);
		expect(measure([new Float64Array(1000)])).toBe(0);
	});

	it("zero input frames do not change an active accumulator", () => {
		const accumulator = new TruePeakAccumulator(1);

		accumulator.push([new Float64Array(0)], 0);

		expect(accumulator.finalize()).toBe(0);
	});

	it("never reports below the raw sample peak", () => {
		const input = new Float64Array([0.1, -0.95, 0.2, -0.4]);
		let samplePeak = 0;

		for (const sample of input) {
			samplePeak = Math.max(samplePeak, Math.abs(sample));
		}

		expect(measure([input])).toBeGreaterThanOrEqual(samplePeak);
	});
});
