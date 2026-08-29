import { describe, expect, it } from "vitest";
import { IntegratedLufsAccumulator } from "./IntegratedLufsAccumulator";

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

const measure = (channels: ReadonlyArray<Float64Array>, sampleRate: number): number => {
	const accumulator = new IntegratedLufsAccumulator(sampleRate, channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return accumulator.finalize();
};

const measureChunked = (input: Float64Array, sampleRate: number, chunkFrames: number): number => {
	const accumulator = new IntegratedLufsAccumulator(sampleRate, 1);

	for (let offset = 0; offset < input.length; offset += chunkFrames) {
		const frames = Math.min(chunkFrames, input.length - offset);
		const slice = input.subarray(offset, offset + frames);

		accumulator.push([slice], frames);
	}

	return accumulator.finalize();
};

describe("IntegratedLufsAccumulator", () => {
	it("measures a 1 kHz sine at -20 dBFS within 0.3 LU of -23 LUFS", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const result = measure([sine], sampleRate);

		expect(result).toBeGreaterThan(-23.3);
		expect(result).toBeLessThan(-22.7);
	});

	it("measures a full-scale mono 997 Hz sine within 0.05 LU of -3.01 LKFS", () => {
		const sampleRate = 48000;
		const sine = generateSine(997, 1, sampleRate, 5);
		const result = measure([sine], sampleRate);

		expect(Math.abs(result - -3.01)).toBeLessThanOrEqual(0.05);
	});

	it("returns -Infinity for silence", () => {
		const sampleRate = 48000;
		const silence = new Float64Array(sampleRate * 2);

		expect(measure([silence], sampleRate)).toBe(-Infinity);
	});

	it("relative-gates a silent tail so integrated stays near the active region", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const silence = new Float64Array(sampleRate * 5);
		const combined = new Float64Array(sine.length + silence.length);

		combined.set(sine, 0);
		combined.set(silence, sine.length);

		const integrated = measure([combined], sampleRate);
		const activeOnly = measure([sine], sampleRate);

		expect(integrated).toBeGreaterThan(activeOnly - 1.0);
		expect(integrated).toBeLessThan(activeOnly + 1.0);
	});

	it("measures two identical channels 3.01 dB louder than one", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const sineCopy = Float64Array.from(sine);
		const mono = measure([sine], sampleRate);
		const stereo = measure([sine, sineCopy], sampleRate);
		const delta = stereo - mono;

		expect(delta).toBeGreaterThan(3.01 - 0.1);
		expect(delta).toBeLessThan(3.01 + 0.1);
	});

	it("agrees within 0.1 LU at 44.1 kHz and 48 kHz", () => {
		const sine48 = generateSine(1000, 0.1, 48000, 5);
		const sine441 = generateSine(1000, 0.1, 44100, 5);
		const lufs48 = measure([sine48], 48000);
		const lufs441 = measure([sine441], 44100);

		expect(Math.abs(lufs48 - lufs441)).toBeLessThan(0.1);
	});

	it("many small pushes are bit-equal to one whole push", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const oneShot = measure([sine], sampleRate);

		expect(measureChunked(sine, sampleRate, 64)).toBe(oneShot);
		expect(measureChunked(sine, sampleRate, 4096)).toBe(oneShot);
		expect(measureChunked(sine, sampleRate, 7777)).toBe(oneShot);
	});

	it("a two-frame tail chunk matches a whole push", () => {
		const sampleRate = 48000;
		const sine = generateSine(1000, 0.1, sampleRate, 5);
		const oneShot = measure([sine], sampleRate);
		const accumulator = new IntegratedLufsAccumulator(sampleRate, 1);
		const headFrames = sine.length - 2;

		accumulator.push([sine.subarray(0, headFrames)], headFrames);
		accumulator.push([sine.subarray(headFrames)], 2);

		expect(accumulator.finalize()).toBe(oneShot);
	});

	it("finalize is idempotent and rejects every later push", () => {
		const accumulator = new IntegratedLufsAccumulator(48000, 1);

		accumulator.push([new Float64Array(48000).fill(0.1)], 48000);

		const first = accumulator.finalize();

		expect(accumulator.finalize()).toBe(first);
		expect(() => accumulator.push([new Float64Array([0.25])], 1)).toThrow("push after finalize");
		expect(() => accumulator.push([new Float64Array(0)], 0)).toThrow("push after finalize");
	});

	it("throws with its own prefix when channelCount is not positive", () => {
		expect(() => new IntegratedLufsAccumulator(48000, 0)).toThrow(
			"IntegratedLufsAccumulator: channelCount must be positive, got 0",
		);
	});
});
