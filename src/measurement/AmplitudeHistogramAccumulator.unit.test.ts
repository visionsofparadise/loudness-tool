import { describe, expect, it } from "vitest";
import { AmplitudeHistogramAccumulator } from "./AmplitudeHistogramAccumulator";

const sumBuckets = (buckets: Uint32Array): number => {
	let total = 0;

	for (let index = 0; index < buckets.length; index++) {
		total += buckets[index] ?? 0;
	}

	return total;
};

const makeRamp = (length: number, amplitude: number): Float64Array => {
	const buffer = new Float64Array(length);

	for (let index = 0; index < length; index++) {
		buffer[index] = length <= 1 ? 0 : (index / (length - 1)) * amplitude;
	}

	return buffer;
};

describe("AmplitudeHistogramAccumulator", () => {
	it("empty input: no push → zero buckets, bucketMax 0, median 0", () => {
		const accumulator = new AmplitudeHistogramAccumulator(32);
		const result = accumulator.finalize();

		expect(result.bucketMax).toBe(0);
		expect(result.median).toBe(0);
		expect(result.buckets.length).toBe(32);
		expect(sumBuckets(result.buckets)).toBe(0);
	});

	it("chunked parity conserves sample count and bucketMax", () => {
		const length = 12_000;
		const samples = new Float64Array(length);
		let state = 1234 >>> 0;

		for (let index = 0; index < length; index++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			samples[index] = (state / 0x1_0000_0000) * 0.9 - 0.45;
		}

		const whole = new AmplitudeHistogramAccumulator(256);

		whole.push(samples, samples.length);

		const wholeResult = whole.finalize();
		const chunkSizes = [97, 4096, 503, 2048, 1700, 2500, 1056];
		const streamed = new AmplitudeHistogramAccumulator(256);
		let cursor = 0;

		for (const size of chunkSizes) {
			streamed.push(samples.subarray(cursor, cursor + size), size);
			cursor += size;
		}

		expect(cursor).toBe(length);

		const streamedResult = streamed.finalize();

		expect(streamedResult.bucketMax).toBe(wholeResult.bucketMax);
		expect(sumBuckets(streamedResult.buckets)).toBe(sumBuckets(wholeResult.buckets));

		const bucketWidth = wholeResult.bucketMax / 256;

		expect(Math.abs(streamedResult.median - wholeResult.median)).toBeLessThan(bucketWidth);
	});

	it("rebuckets when a later chunk exceeds the running max", () => {
		const bucketCount = 64;
		const accumulator = new AmplitudeHistogramAccumulator(bucketCount);
		const chunk1 = makeRamp(1000, 0.3);
		const chunk2 = makeRamp(2000, 0.7);

		accumulator.push(chunk1, chunk1.length);
		accumulator.push(chunk2, chunk2.length);

		const result = accumulator.finalize();

		expect(result.bucketMax).toBeCloseTo(0.7, 12);
		expect(sumBuckets(result.buckets)).toBe(chunk1.length + chunk2.length);

		let upperHalfCount = 0;

		for (let bucketIndex = 30; bucketIndex < bucketCount; bucketIndex++) {
			upperHalfCount += result.buckets[bucketIndex] ?? 0;
		}

		expect(upperHalfCount).toBeGreaterThan(800);
		expect(upperHalfCount).toBeLessThan(1300);
	});

	it("constructor validates bucketCount", () => {
		expect(() => new AmplitudeHistogramAccumulator(0)).toThrow();
		expect(() => new AmplitudeHistogramAccumulator(-1)).toThrow();
		expect(() => new AmplitudeHistogramAccumulator(1.5)).toThrow();
	});

	it("push validates buffer length against count", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);

		expect(() => accumulator.push(new Float64Array(8), 16)).toThrow();
	});

	it("re-finalize is idempotent", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);

		accumulator.push(Float64Array.from([0.1, 0.2, 0.3, 0.4]), 4);

		const first = accumulator.finalize();
		const second = accumulator.finalize();

		expect(second).toBe(first);
		expect(second.bucketMax).toBe(first.bucketMax);
		expect(second.median).toBe(first.median);
	});

	it("push after finalize throws", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);

		accumulator.push(Float64Array.from([0.1, 0.2]), 2);
		accumulator.finalize();

		expect(() => accumulator.push(Float64Array.from([0.3]), 1)).toThrow();
	});

	it("takes absolute linear amplitudes", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);

		accumulator.push(Float64Array.from([0.1, 0.2, 0.3, 0.4, -0.5, 0.6, 0.7, 0.8, -0.9, 0.05]), 10);

		const result = accumulator.finalize();

		expect(result.bucketMax).toBeCloseTo(0.9, 12);
		expect(sumBuckets(result.buckets)).toBe(10);
	});

	it("flushes pending zeros into bucket 0 once a nonzero chunk arrives", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);
		const silence = new Float64Array(500);
		const signal = Float64Array.from([0.4, 0.5, 0.6, 0.7, 0.8]);

		accumulator.push(silence, silence.length);
		accumulator.push(signal, signal.length);

		const result = accumulator.finalize();

		expect(result.bucketMax).toBeCloseTo(0.8, 12);
		expect(sumBuckets(result.buckets)).toBe(silence.length + signal.length);
		expect(result.buckets[0]).toBe(500);
	});

	it("only-silence: bucketMax 0, median 0, empty buckets", () => {
		const accumulator = new AmplitudeHistogramAccumulator(16);

		accumulator.push(new Float64Array(1000), 1000);
		accumulator.push(new Float64Array(2000), 2000);

		const result = accumulator.finalize();

		expect(result.bucketMax).toBe(0);
		expect(result.median).toBe(0);
		expect(sumBuckets(result.buckets)).toBe(0);
	});
});
