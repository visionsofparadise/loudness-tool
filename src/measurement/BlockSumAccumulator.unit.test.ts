import { describe, expect, it } from "vitest";
import { BlockSumAccumulator } from "./BlockSumAccumulator";

describe("BlockSumAccumulator", () => {
	it("closes 7 overlapping blocks of sum 400 from 1000 constant-1 samples", () => {
		const accumulator = new BlockSumAccumulator(400, 100);
		const input = new Float64Array(1000);

		input.fill(1);
		accumulator.push(input, 1000);

		const closed = accumulator.finalize();

		expect(closed.length).toBe(7);

		for (const sum of closed) {
			expect(sum).toBe(400);
		}
	});

	it("returns disjoint window sums when blockSize equals blockStep", () => {
		const accumulator = new BlockSumAccumulator(100, 100);
		const input = new Float64Array(500);

		for (let index = 0; index < 500; index++) {
			input[index] = index;
		}

		accumulator.push(input, 500);

		const closed = accumulator.finalize();

		expect(closed.length).toBe(5);

		for (let blockIndex = 0; blockIndex < 5; blockIndex++) {
			let expected = 0;

			for (let index = blockIndex * 100; index < (blockIndex + 1) * 100; index++) {
				expected += index;
			}

			expect(closed[blockIndex]).toBe(expected);
		}
	});

	it("chunked pushes are bit-equal to one whole push", () => {
		const total = 4096;
		const input = new Float64Array(total);

		for (let index = 0; index < total; index++) {
			input[index] = Math.sin(0.01 * index);
		}

		const oneShot = new BlockSumAccumulator(400, 100);

		oneShot.push(input, total);

		const oneShotClosed = oneShot.finalize();
		const streamed = new BlockSumAccumulator(400, 100);
		const chunkSize = 333;

		for (let offset = 0; offset < total; offset += chunkSize) {
			const count = Math.min(chunkSize, total - offset);
			const slice = input.subarray(offset, offset + count);

			streamed.push(slice, count);
		}

		const streamedClosed = streamed.finalize();

		expect(Array.from(streamedClosed)).toEqual(Array.from(oneShotClosed));
	});

	it("returns an empty Float64Array when nothing was pushed", () => {
		const accumulator = new BlockSumAccumulator(400, 100);

		expect(accumulator.finalize()).toEqual(new Float64Array(0));
	});

	it("finalize is idempotent", () => {
		const accumulator = new BlockSumAccumulator(100, 100);
		const input = new Float64Array(300);

		input.fill(2);
		accumulator.push(input, 300);

		const first = accumulator.finalize();

		expect(accumulator.finalize()).toBe(first);
	});

	it("rejects every later push", () => {
		const accumulator = new BlockSumAccumulator(100, 100);

		accumulator.finalize();

		expect(() => accumulator.push(new Float64Array(10), 10)).toThrow(/finalize/);
	});

	it("throws when blockSize is not positive", () => {
		expect(() => new BlockSumAccumulator(0, 100)).toThrow(/blockSize/);
	});

	it("throws when blockStep is not positive", () => {
		expect(() => new BlockSumAccumulator(400, 0)).toThrow(/blockStep/);
	});
});
