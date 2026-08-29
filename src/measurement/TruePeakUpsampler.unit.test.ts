import { describe, expect, it } from "vitest";
import { TruePeakUpsampler } from "./TruePeakUpsampler";

const PHASE_COEFFICIENTS: ReadonlyArray<ReadonlyArray<number>> = [
	[
		0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875,
		-0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125,
	],
	[
		-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625,
		-0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375,
	],
	[
		-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625, 0.465087890625,
		-0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875,
	],
	[
		-0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875, 0.1373291015625,
		-0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375,
	],
];
const PHASES = PHASE_COEFFICIENTS.length;
const TAPS = PHASE_COEFFICIENTS[0]?.length ?? 0;
const TAIL_POSITIONS = TAPS - 1;
const OVERSAMPLE_FACTOR = 4;
const FLUSH_OUTPUT_SAMPLES = TAIL_POSITIONS * OVERSAMPLE_FACTOR;

const directConvolution = (input: Float64Array, tailPositions = TAIL_POSITIONS): Float64Array => {
	const positions = input.length + tailPositions;
	const output = new Float64Array(positions * PHASES);

	for (let position = 0; position < positions; position++) {
		for (let phase = 0; phase < PHASES; phase++) {
			const coefficients = PHASE_COEFFICIENTS[phase];
			let sum = 0;

			for (let tap = 0; tap < TAPS; tap++) {
				const inputIndex = position - tap;
				const sample = inputIndex >= 0 && inputIndex < input.length ? (input[inputIndex] ?? 0) : 0;

				sum += (coefficients?.[tap] ?? 0) * sample;
			}

			output[position * PHASES + phase] = sum;
		}
	}

	return output;
};

const concatenate = (parts: ReadonlyArray<Float64Array>): Float64Array => {
	const length = parts.reduce((total, part) => total + part.length, 0);
	const output = new Float64Array(length);
	let offset = 0;

	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}

	return output;
};

const take = (buffer: Float64Array, count: number): Float64Array => buffer.slice(0, count);

const runFinite = (input: Float64Array, splitPoints?: ReadonlyArray<number>): Float64Array => {
	const upsampler = new TruePeakUpsampler();
	const parts: Array<Float64Array> = [];

	if (splitPoints === undefined) {
		const output = new Float64Array(input.length * OVERSAMPLE_FACTOR);
		const count = upsampler.upsample(input, input.length, output);

		parts.push(take(output, count));
	} else {
		let offset = 0;

		for (const end of [...splitPoints, input.length]) {
			const frameCount = end - offset;
			const output = new Float64Array(frameCount * OVERSAMPLE_FACTOR);
			const count = upsampler.upsample(input.subarray(offset, end), frameCount, output);

			parts.push(take(output, count));
			offset = end;
		}
	}

	const flushOutput = new Float64Array(FLUSH_OUTPUT_SAMPLES);
	const flushCount = upsampler.flush(flushOutput);

	parts.push(take(flushOutput, flushCount));

	return concatenate(parts);
};

describe("TruePeakUpsampler", () => {
	it("emits the four published phase columns for an impulse, including the FIR tail", () => {
		const output = runFinite(new Float64Array([1]));

		expect(output.length).toBe(TAPS * PHASES);

		for (let tap = 0; tap < TAPS; tap++) {
			for (let phase = 0; phase < PHASES; phase++) {
				const actual = output[tap * PHASES + phase] ?? 0;
				const expected = PHASE_COEFFICIENTS[phase]?.[tap] ?? 0;

				expect(Math.abs(actual - expected)).toBeLessThan(1e-7);
			}
		}
	});

	it("matches a test-local direct convolution over arbitrary input and 11 trailing zeros", () => {
		const input = new Float64Array([0.25, -0.75, 0.125, 0.9, -0.33, 0.02, 0.5]);
		const actual = runFinite(input);
		const expected = directConvolution(input);
		let maxError = 0;

		for (let index = 0; index < actual.length; index++) {
			maxError = Math.max(maxError, Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)));
		}

		expect(maxError).toBeLessThan(1e-6);
	});

	it("arbitrary chunk splits are byte-identical to one whole input", () => {
		const input = new Float64Array(37);

		for (let index = 0; index < input.length; index++) {
			input[index] = Math.sin(index * 0.37) * 0.8 + Math.cos(index * 0.11) * 0.1;
		}

		const whole = runFinite(input);
		const chunked = runFinite(input, [1, 3, 8, 9, 21, 34]);

		expect(chunked).toEqual(whole);
	});

	it("writes into an oversized output and throws for an undersized one", () => {
		const input = new Float64Array([0.1, 0.2, 0.3]);
		const oversized = new Float64Array(20);

		oversized.fill(Number.NaN);

		const oversizedCount = new TruePeakUpsampler().upsample(input, 3, oversized);

		expect(oversizedCount).toBe(12);
		expect(Number.isNaN(oversized[12])).toBe(true);

		expect(() => new TruePeakUpsampler().upsample(input, 3, new Float64Array(11))).toThrow(
			"below the 12 samples required",
		);

		const flushOversized = new Float64Array(64);
		const flushUpsampler = new TruePeakUpsampler();

		flushUpsampler.upsample(input, 3, new Float64Array(12));
		flushOversized.fill(Number.NaN);

		const flushCount = flushUpsampler.flush(flushOversized);

		expect(flushCount).toBe(44);
		expect(Number.isNaN(flushOversized[44])).toBe(true);

		const allocatingFlushUpsampler = new TruePeakUpsampler();

		allocatingFlushUpsampler.upsample(input, 3, new Float64Array(12));

		expect(() => allocatingFlushUpsampler.flush(new Float64Array(43))).toThrow("below the 44 samples required");
	});

	it("flush is idempotent and blocks more input until reset", () => {
		const upsampler = new TruePeakUpsampler();

		upsampler.upsample(new Float64Array([0.5]), 1, new Float64Array(4));

		expect(upsampler.flush(new Float64Array(44))).toBe(44);
		expect(upsampler.flush(new Float64Array(44))).toBe(0);
		expect(() => upsampler.upsample(new Float64Array([0.25]), 1, new Float64Array(4))).toThrow(
			"upsample after flush",
		);

		upsampler.reset();

		expect(() => upsampler.upsample(new Float64Array([0.25]), 1, new Float64Array(4))).not.toThrow();
	});

	it("reset restores the complete cold finite-input result", () => {
		const input = new Float64Array([0.3, -0.2, 0.7, -0.4]);
		const fresh = runFinite(input);
		const reused = new TruePeakUpsampler();

		reused.upsample(new Float64Array([0.9, -0.8]), 2, new Float64Array(8));
		reused.flush(new Float64Array(44));
		reused.reset();

		const afterInput = new Float64Array(input.length * OVERSAMPLE_FACTOR);
		const afterInputCount = reused.upsample(input, input.length, afterInput);
		const afterFlush = new Float64Array(FLUSH_OUTPUT_SAMPLES);
		const afterFlushCount = reused.flush(afterFlush);
		const afterReset = concatenate([take(afterInput, afterInputCount), take(afterFlush, afterFlushCount)]);

		expect(afterReset).toEqual(fresh);
	});

	it("empty input returns empty output before the finite tail is drained", () => {
		const upsampler = new TruePeakUpsampler();

		expect(upsampler.upsample(new Float64Array(0), 0, new Float64Array(0))).toBe(0);
		expect(upsampler.flush(new Float64Array(44))).toBe(44);
	});
});
