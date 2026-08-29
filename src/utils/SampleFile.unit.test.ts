import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { SampleFile } from "./SampleFile";
import { Scratch } from "./Scratch";

const SAMPLE_FILE_BLOCK_FRAMES = 65536;

const collect = async (iterable: AsyncIterable<Float64Array>): Promise<Float64Array> => {
	const chunks: Array<Float64Array> = [];
	let total = 0;

	for await (const chunk of iterable) {
		chunks.push(chunk);
		total += chunk.length;
	}

	const merged = new Float64Array(total);
	let cursor = 0;

	for (const chunk of chunks) {
		merged.set(chunk, cursor);
		cursor += chunk.length;
	}

	return merged;
};

const collectChunks = async (iterable: AsyncIterable<Float64Array>): Promise<Array<Float64Array>> => {
	const chunks: Array<Float64Array> = [];

	for await (const chunk of iterable) {
		chunks.push(Float64Array.from(chunk));
	}

	return chunks;
};

describe("SampleFile", () => {
	let scratch: Scratch | undefined;

	afterEach(async () => {
		if (scratch !== undefined) {
			await scratch.dispose();
			scratch = undefined;
		}
	});

	it("round-trips appended samples across block boundaries", async () => {
		scratch = await Scratch.create();

		const file = await SampleFile.create(scratch, "across-blocks");
		const first = new Float64Array(SAMPLE_FILE_BLOCK_FRAMES);
		const second = new Float64Array(100);

		for (let index = 0; index < first.length; index++) {
			first[index] = index + 0.25;
		}

		for (let index = 0; index < second.length; index++) {
			second[index] = -(index + 1);
		}

		await file.append(first, first.length);
		await file.append(second, second.length);

		expect(file.frameCount).toBe(SAMPLE_FILE_BLOCK_FRAMES + 100);

		const forward = await collect(file.blocks());
		const expected = new Float64Array(first.length + second.length);

		expected.set(first, 0);
		expected.set(second, first.length);

		expect(forward).toEqual(expected);

		const chunks = await collectChunks(file.blocks());

		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.length).toBe(SAMPLE_FILE_BLOCK_FRAMES);
		expect(chunks[1]?.length).toBe(100);

		await file.close();
	});

	it("reverse iteration equals the reversed forward read", async () => {
		scratch = await Scratch.create();

		const file = await SampleFile.create(scratch, "reverse");
		const samples = new Float64Array(SAMPLE_FILE_BLOCK_FRAMES + 17);

		for (let index = 0; index < samples.length; index++) {
			samples[index] = Math.sin(index / 13) * (index + 1);
		}

		await file.append(samples, samples.length);

		const forward = await collect(file.blocks());
		const reversed = await collect(file.reverseBlocks());
		const expected = Float64Array.from(forward).reverse();

		expect(reversed).toEqual(expected);

		await file.close();
	});

	it("yields a ragged tail as the first reverse stripe", async () => {
		scratch = await Scratch.create();

		const file = await SampleFile.create(scratch, "ragged");
		const tail = 123;
		const samples = new Float64Array(SAMPLE_FILE_BLOCK_FRAMES + tail);

		for (let index = 0; index < samples.length; index++) {
			samples[index] = index;
		}

		await file.append(samples, samples.length);

		const reverseChunks = await collectChunks(file.reverseBlocks());

		expect(reverseChunks).toHaveLength(2);
		expect(reverseChunks[0]?.length).toBe(tail);
		expect(reverseChunks[1]?.length).toBe(SAMPLE_FILE_BLOCK_FRAMES);
		expect(Array.from(reverseChunks[0] ?? [])).toEqual(Array.from(samples.subarray(samples.length - tail)).reverse());

		await file.close();
	});

	it("round-trips a short file smaller than one block", async () => {
		scratch = await Scratch.create();

		const file = await SampleFile.create(scratch, "short");
		const samples = Float64Array.from([1, -2, 3.5, 0, -0]);

		await file.append(samples, samples.length);

		expect(await collect(file.blocks())).toEqual(samples);
		expect(await collect(file.reverseBlocks())).toEqual(Float64Array.from(samples).reverse());

		await file.close();
	});

	it("treats a zero-length append as a no-op", async () => {
		scratch = await Scratch.create();

		const file = await SampleFile.create(scratch, "empty-append");

		await file.append(new Float64Array(4), 0);

		expect(file.frameCount).toBe(0);
		expect(await collect(file.blocks())).toEqual(new Float64Array(0));
		expect(await collect(file.reverseBlocks())).toEqual(new Float64Array(0));

		await file.close();
	});

	it("close deletes the file and is idempotent", async () => {
		scratch = await Scratch.create();

		const file = await SampleFile.create(scratch, "close-me");

		await file.append(Float64Array.from([1, 2, 3]), 3);

		const path = scratch.filePath("close-me");

		expect(existsSync(path)).toBe(true);

		await file.close();
		await file.close();

		expect(existsSync(path)).toBe(false);
	});

	it("scratch dispose removes remaining sample files", async () => {
		scratch = await Scratch.create();

		const file = await SampleFile.create(scratch, "left-open");

		await file.append(Float64Array.from([9, 8, 7]), 3);

		const directory = scratch.directory;

		await file.close();
		await scratch.dispose();
		scratch = undefined;

		expect(existsSync(directory)).toBe(false);
	});

	it("throws after close", async () => {
		scratch = await Scratch.create();

		const file = await SampleFile.create(scratch, "closed");

		await file.close();

		await expect(file.append(Float64Array.from([1]), 1)).rejects.toThrow(/after close/);
	});

	it("throws on a duplicate live label", async () => {
		scratch = await Scratch.create();

		const file = await SampleFile.create(scratch, "shared");

		await expect(SampleFile.create(scratch, "shared")).rejects.toThrow(/already live/);

		await file.close();

		const reused = await SampleFile.create(scratch, "shared");

		await reused.close();
	});

	it("throws on a label that escapes the directory", async () => {
		scratch = await Scratch.create();

		await expect(SampleFile.create(scratch, "../escaped")).rejects.toThrow(/must match/);
	});
});

describe("Scratch plus SampleFile", () => {
	it("dispose removes everything even after files are closed", async () => {
		const scratch = await Scratch.create();
		const file = await SampleFile.create(scratch, "payload");

		await file.append(new Float64Array(8).fill(0.5), 8);
		await file.close();

		expect(await readdir(scratch.directory)).toEqual([]);

		await scratch.dispose();

		expect(existsSync(scratch.directory)).toBe(false);
	});
});
