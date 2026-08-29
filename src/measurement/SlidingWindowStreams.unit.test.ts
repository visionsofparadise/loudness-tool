import { describe, expect, it } from "vitest";
import { SlidingWindowMaxStream, SlidingWindowMinStream } from "./SlidingWindowStreams";

const makeLcg = (seed: number): (() => number) => {
	let state = seed >>> 0;

	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

		return state / 0x80_00_00_00 - 1;
	};
};

const makeFixture = (length: number, seed: number): Float64Array => {
	const result = new Float64Array(length);
	const rand = makeLcg(seed);

	for (let frameIndex = 0; frameIndex < length; frameIndex++) {
		const envelope = 0.4 + 0.5 * Math.sin((2 * Math.PI * frameIndex) / 137);
		const noise = rand();

		result[frameIndex] = envelope * noise;
	}

	return result;
};

interface Variant {
	readonly name: string;
	readonly openStream: (halfWidth: number) => { push: (chunk: Float64Array, isFinal: boolean) => Float64Array };
	readonly isBetter: (candidate: number, incumbent: number) => boolean;
	readonly worst: number;
}

const VARIANTS: ReadonlyArray<Variant> = [
	{
		name: "Max",
		openStream: (halfWidth) => new SlidingWindowMaxStream(halfWidth),
		isBetter: (candidate, incumbent) => candidate > incumbent,
		worst: -Infinity,
	},
	{
		name: "Min",
		openStream: (halfWidth) => new SlidingWindowMinStream(halfWidth),
		isBetter: (candidate, incumbent) => candidate < incumbent,
		worst: Infinity,
	},
];

const slidingWindowNaive = (input: Float64Array, halfWidth: number, variant: Variant): Float64Array => {
	const length = input.length;
	const output = new Float64Array(length);

	for (let outputIndex = 0; outputIndex < length; outputIndex++) {
		const leftEdge = Math.max(0, outputIndex - halfWidth);
		const rightEdge = Math.min(length - 1, outputIndex + halfWidth);
		let best = variant.worst;

		for (let windowIndex = leftEdge; windowIndex <= rightEdge; windowIndex++) {
			const value = input[windowIndex] ?? 0;

			if (variant.isBetter(value, best)) {
				best = value;
			}
		}

		output[outputIndex] = best;
	}

	return output;
};

const runStreaming = (input: Float64Array, halfWidth: number, chunkSize: number, variant: Variant): Float64Array => {
	const stream = variant.openStream(halfWidth);
	const collected: Array<Float64Array> = [];
	let totalEmitted = 0;
	let cursor = 0;

	while (cursor < input.length) {
		const remaining = input.length - cursor;
		const take = Math.min(chunkSize, remaining);
		const chunk = input.subarray(cursor, cursor + take);
		const isFinal = cursor + take >= input.length;
		const piece = stream.push(chunk, isFinal);

		collected.push(piece);
		totalEmitted += piece.length;
		cursor += take;
	}

	const output = new Float64Array(totalEmitted);
	let writeOffset = 0;

	for (const piece of collected) {
		output.set(piece, writeOffset);
		writeOffset += piece.length;
	}

	return output;
};

describe.each(VARIANTS)("SlidingWindow$nameStream", (variant) => {
	it("matches the naive reference on a small fixture", () => {
		const input = makeFixture(257, 0xdead_beef);
		const halfWidth = 12;
		const expected = slidingWindowNaive(input, halfWidth, variant);
		const actual = runStreaming(input, halfWidth, input.length, variant);

		expect(actual.length).toBe(input.length);

		for (let frameIndex = 0; frameIndex < input.length; frameIndex++) {
			expect(actual[frameIndex]).toBe(expected[frameIndex]);
		}
	});

	it("byte-equivalent to the whole-array reference at several chunk sizes", () => {
		const input = makeFixture(5000, 0xface_f00d);
		const halfWidth = 50;
		const reference = slidingWindowNaive(input, halfWidth, variant);

		for (const chunkSize of [1, 100, 333, 1000]) {
			const streamed = runStreaming(input, halfWidth, chunkSize, variant);

			expect(streamed.length).toBe(reference.length);

			for (let frameIndex = 0; frameIndex < reference.length; frameIndex++) {
				expect(streamed[frameIndex]).toBe(reference[frameIndex]);
			}
		}
	});

	it("halfWidth 0 returns the input", () => {
		const input = makeFixture(200, 0xbadc_afe);
		const streamed = runStreaming(input, 0, 33, variant);

		for (let frameIndex = 0; frameIndex < input.length; frameIndex++) {
			expect(streamed[frameIndex]).toBe(input[frameIndex]);
		}
	});

	it("source shorter than halfWidth still emits all outputs once isFinal is signalled", () => {
		const input = makeFixture(10, 0xcafe_babe);
		const halfWidth = 50;
		const reference = slidingWindowNaive(input, halfWidth, variant);
		const streamed = runStreaming(input, halfWidth, 4, variant);

		expect(streamed.length).toBe(input.length);

		for (let frameIndex = 0; frameIndex < input.length; frameIndex++) {
			expect(streamed[frameIndex]).toBe(reference[frameIndex]);
		}
	});

	it("empty input with isFinal returns an empty output", () => {
		const stream = variant.openStream(5);
		const result = stream.push(new Float64Array(0), true);

		expect(result.length).toBe(0);
	});

	it("names the constructed class in the RangeError", () => {
		expect(() => variant.openStream(-1)).toThrow(new RegExp(`SlidingWindow${variant.name}Stream`));
	});
});

describe.each(VARIANTS)("SlidingWindow$nameStream strictly monotone runs", (variant) => {
	const halfWidths = [1, 17] as const;

	const makeRamp = (length: number, ascending: boolean): Float64Array => {
		const input = new Float64Array(length);

		for (let frameIndex = 0; frameIndex < length; frameIndex++) {
			input[frameIndex] = ascending ? frameIndex + 1 : length - frameIndex;
		}

		return input;
	};

	for (const halfWidth of halfWidths) {
		const length = 8 * (2 * halfWidth + 1);

		for (const chunkSize of [1, 3, length]) {
			it(`strictly decreasing matches the naive windowed extreme (halfWidth ${halfWidth}, chunk ${chunkSize})`, () => {
				const input = makeRamp(length, false);
				const expected = slidingWindowNaive(input, halfWidth, variant);
				const actual = runStreaming(input, halfWidth, chunkSize, variant);

				expect(actual.length).toBe(expected.length);

				for (let frameIndex = 0; frameIndex < expected.length; frameIndex++) {
					expect(actual[frameIndex]).toBe(expected[frameIndex]);
				}
			});

			it(`strictly increasing matches the naive windowed extreme (halfWidth ${halfWidth}, chunk ${chunkSize})`, () => {
				const input = makeRamp(length, true);
				const expected = slidingWindowNaive(input, halfWidth, variant);
				const actual = runStreaming(input, halfWidth, chunkSize, variant);

				expect(actual.length).toBe(expected.length);

				for (let frameIndex = 0; frameIndex < expected.length; frameIndex++) {
					expect(actual[frameIndex]).toBe(expected[frameIndex]);
				}
			});
		}
	}
});

describe("SlidingWindowMinStream", () => {
	it("spike-down in a flat-high region equals the spike within halfWidth", () => {
		const length = 200;
		const halfWidth = 10;
		const input = new Float64Array(length);
		const spike = 0.1;

		input.fill(1.0);
		input[100] = spike;

		const result = runStreaming(input, halfWidth, 40, VARIANTS[1] as Variant);

		for (let frameIndex = 100 - halfWidth; frameIndex <= 100 + halfWidth; frameIndex++) {
			expect(result[frameIndex]).toBe(spike);
		}

		expect(result[100 - halfWidth - 1]).toBe(1.0);
		expect(result[100 + halfWidth + 1]).toBe(1.0);
	});
});

describe("max-of-4 collapse equivalence", () => {
	it("slider(max-of-4(x4)) equals max of a 4x slider on each phase", () => {
		const baseFrames = 1024;
		const halfWidth = 12;
		const oversampled = new Float64Array(baseFrames * 4);
		const rand = makeLcg(0xabc_def);

		for (let index = 0; index < oversampled.length; index++) {
			oversampled[index] = Math.abs(rand());
		}

		const collapsed = new Float64Array(baseFrames);

		for (let baseIndex = 0; baseIndex < baseFrames; baseIndex++) {
			const offset = baseIndex * 4;
			const s0 = oversampled[offset] ?? 0;
			const s1 = oversampled[offset + 1] ?? 0;
			const s2 = oversampled[offset + 2] ?? 0;
			const s3 = oversampled[offset + 3] ?? 0;
			const m01 = s0 > s1 ? s0 : s1;
			const m23 = s2 > s3 ? s2 : s3;

			collapsed[baseIndex] = m01 > m23 ? m01 : m23;
		}

		const baseSlider = new SlidingWindowMaxStream(halfWidth);
		const fromCollapsed = baseSlider.push(collapsed, true);

		const oversampledSlider = new SlidingWindowMaxStream(halfWidth * 4);
		const fromOversampled = oversampledSlider.push(oversampled, true);
		const collapsedOversampled = new Float64Array(baseFrames);

		for (let baseIndex = 0; baseIndex < baseFrames; baseIndex++) {
			const offset = baseIndex * 4;
			const s0 = fromOversampled[offset] ?? 0;
			const s1 = fromOversampled[offset + 1] ?? 0;
			const s2 = fromOversampled[offset + 2] ?? 0;
			const s3 = fromOversampled[offset + 3] ?? 0;
			const m01 = s0 > s1 ? s0 : s1;
			const m23 = s2 > s3 ? s2 : s3;

			collapsedOversampled[baseIndex] = m01 > m23 ? m01 : m23;
		}

		expect(fromCollapsed.length).toBe(baseFrames);

		for (let baseIndex = 0; baseIndex < baseFrames; baseIndex++) {
			expect(fromCollapsed[baseIndex]).toBe(collapsedOversampled[baseIndex]);
		}
	});
});
