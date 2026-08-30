import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoise, createSine } from "../utils/testSignals";
import { WavReader, type AudioBlock } from "./WavReader";
import { WavWriter } from "./WavWriter";
import { assertRiffDataSize, type WavBitDepth } from "./utils/wavFormat";

vi.mock("node:fs/promises", { spy: true });

const SAMPLE_RATE = 48000;

const quantizationStepOf = (bitDepth: WavBitDepth): number => {
	switch (bitDepth) {
		case "16":
			return 1.5 / 0x8000;
		case "24":
			return 1.5 / 0x800000;
		case "32":
			return 1.5 / 0x80000000;
		case "32f":
			return 0;
	}
};

const mergeBlocks = (blocks: Array<AudioBlock>): Array<Float64Array> => {
	const channelCount = blocks[0]?.channels.length ?? 0;
	const frameCount = blocks.reduce((total, block) => total + (block.channels[0]?.length ?? 0), 0);
	const merged: Array<Float64Array> = [];

	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		merged.push(new Float64Array(frameCount));
	}

	let cursor = 0;

	for (const block of blocks) {
		const blockFrames = block.channels[0]?.length ?? 0;

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			merged[channelIndex]?.set(block.channels[channelIndex] ?? new Float64Array(blockFrames), cursor);
		}

		cursor += blockFrames;
	}

	return merged;
};

const readAll = async (path: string): Promise<{ format: WavReader["format"]; channels: Array<Float64Array> }> => {
	const reader = await WavReader.open(path);
	const blocks: Array<AudioBlock> = [];

	for await (const block of reader.blocks()) {
		blocks.push(block);
	}

	await reader.close();

	return { format: reader.format, channels: mergeBlocks(blocks) };
};

const expectChannelsMatch = (
	actual: Array<Float64Array>,
	expected: ReadonlyArray<Float64Array>,
	bitDepth: WavBitDepth,
): void => {
	expect(actual.length).toBe(expected.length);

	const step = quantizationStepOf(bitDepth);

	for (let channelIndex = 0; channelIndex < expected.length; channelIndex++) {
		const actualChannel = actual[channelIndex];
		const expectedChannel = expected[channelIndex];

		expect(actualChannel?.length).toBe(expectedChannel?.length);

		for (let frameIndex = 0; frameIndex < (expectedChannel?.length ?? 0); frameIndex++) {
			const actualSample = actualChannel?.[frameIndex] ?? 0;
			const expectedSample = expectedChannel?.[frameIndex] ?? 0;

			if (bitDepth === "32f") {
				expect(actualSample).toBe(Math.fround(expectedSample));
			} else {
				expect(Math.abs(actualSample - expectedSample)).toBeLessThanOrEqual(step);
			}
		}
	}
};

const temporaryNamesOf = async (directory: string): Promise<Array<string>> => {
	const names = await fsPromises.readdir(directory);

	return names.filter((name) => name.endsWith(".tmp"));
};

describe("assertRiffDataSize", () => {
	it("accepts sizes at and below the RIFF payload ceiling", () => {
		expect(() => {
			assertRiffDataSize(0);
		}).not.toThrow();
		expect(() => {
			assertRiffDataSize(0xffffffff - 36);
		}).not.toThrow();
	});

	it("throws past the RIFF payload ceiling naming the payload limit", () => {
		expect(() => {
			assertRiffDataSize(0xffffffff - 36 + 1);
		}).toThrow(/4294967259|payload ceiling/);
	});
});

describe("WavWriter", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await fsPromises.mkdtemp(join(tmpdir(), "loudness-tool-wav-writer-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsPromises.rm(workingDirectory, { recursive: true, force: true });
	});

	it.each([
		["16", 1],
		["16", 2],
		["24", 1],
		["24", 2],
		["32", 1],
		["32", 2],
		["32f", 1],
		["32f", 2],
	] as const)("round-trips %s with %i channel(s)", async (bitDepth, channelCount) => {
		const path = join(workingDirectory, `${bitDepth}-${channelCount}.wav`);
		const channels = createNoise(256, channelCount, 99 + channelCount);
		const writer = await WavWriter.create(path, { sampleRate: SAMPLE_RATE, channelCount, bitDepth });

		await writer.write(channels);
		await writer.close();

		const read = await readAll(path);

		expect(read.format.sampleRate).toBe(SAMPLE_RATE);
		expect(read.format.channelCount).toBe(channelCount);
		expect(read.format.bitDepth).toBe(bitDepth);
		expect(read.format.frameCount).toBe(256);
		expectChannelsMatch(read.channels, channels, bitDepth);
	});

	it("keeps the destination absent while writing and present after close", async () => {
		const path = join(workingDirectory, "output.wav");
		const writer = await WavWriter.create(path, { sampleRate: SAMPLE_RATE, channelCount: 1, bitDepth: "16" });

		await writer.write(createSine(64, 1, SAMPLE_RATE, 440, 0.75));

		expect(existsSync(path)).toBe(false);
		expect(await temporaryNamesOf(workingDirectory)).toHaveLength(1);

		await writer.close();

		expect(existsSync(path)).toBe(true);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("abort leaves no destination and no temporary file", async () => {
		const path = join(workingDirectory, "aborted.wav");
		const writer = await WavWriter.create(path, { sampleRate: SAMPLE_RATE, channelCount: 1, bitDepth: "24" });

		await writer.write(createNoise(32, 1, 3));
		await writer.abort();

		expect(existsSync(path)).toBe(false);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("supports in-place processing: original readable until close, output correct after", async () => {
		const path = join(workingDirectory, "inplace.wav");
		const original = createSine(128, 2, SAMPLE_RATE, 220, 0.75);
		const replacement = createNoise(128, 2, 21);
		const originalWriter = await WavWriter.create(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			bitDepth: "32f",
		});

		await originalWriter.write(original);
		await originalWriter.close();

		const reader = await WavReader.open(path);
		const writer = await WavWriter.create(path, { sampleRate: SAMPLE_RATE, channelCount: 2, bitDepth: "32f" });

		const blocks: Array<AudioBlock> = [];

		for await (const block of reader.blocks()) {
			blocks.push(block);
		}

		expectChannelsMatch(mergeBlocks(blocks), original, "32f");
		expect(existsSync(path)).toBe(true);

		await writer.write(replacement);

		const peek = await WavReader.open(path);
		const peekBlocks: Array<AudioBlock> = [];

		for await (const block of peek.blocks()) {
			peekBlocks.push(block);
		}

		await peek.close();
		expectChannelsMatch(mergeBlocks(peekBlocks), original, "32f");

		await reader.close();
		await writer.close();

		const read = await readAll(path);

		expectChannelsMatch(read.channels, replacement, "32f");
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("abort during in-place processing leaves the original intact and no temporary file", async () => {
		const path = join(workingDirectory, "inplace-abort.wav");
		const original = createSine(64, 1, SAMPLE_RATE, 330, 0.75);
		const originalWriter = await WavWriter.create(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "32f",
		});

		await originalWriter.write(original);
		await originalWriter.close();

		const writer = await WavWriter.create(path, { sampleRate: SAMPLE_RATE, channelCount: 1, bitDepth: "32f" });

		await writer.write(createNoise(64, 1, 5));
		await writer.abort();

		expect(existsSync(path)).toBe(true);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);

		const read = await readAll(path);

		expectChannelsMatch(read.channels, original, "32f");
	});

	it("throws on channel-count mismatch with the stated message", async () => {
		const path = join(workingDirectory, "mismatch.wav");
		const writer = await WavWriter.create(path, { sampleRate: SAMPLE_RATE, channelCount: 2, bitDepth: "16" });

		await expect(writer.write([new Float64Array(8)])).rejects.toThrow(
			"Channel count mismatch: expected 2, received 1",
		);

		await writer.abort();
	});

	it("ends an odd data chunk at the last sample byte and round-trips 5-frame 24-bit mono", async () => {
		const path = join(workingDirectory, "odd-24.wav");
		const channels = createSine(5, 1, SAMPLE_RATE, 440, 0.75);
		const writer = await WavWriter.create(path, { sampleRate: SAMPLE_RATE, channelCount: 1, bitDepth: "24" });

		await writer.write(channels);
		await writer.close();

		const bytes = await fsPromises.readFile(path);

		expect(bytes.length).toBe(59);
		expect(bytes.readUInt32LE(4)).toBe(51);
		expect(bytes.readUInt32LE(40)).toBe(15);

		const read = await readAll(path);

		expect(read.format.bitDepth).toBe("24");
		expect(read.format.frameCount).toBe(5);
		expectChannelsMatch(read.channels, channels, "24");
	});

	it("leaves destination file bytes untouched when rename fails", async () => {
		const path = join(workingDirectory, "existing.wav");

		await fsPromises.writeFile(path, "original-bytes");

		const writer = await WavWriter.create(path, { sampleRate: SAMPLE_RATE, channelCount: 1, bitDepth: "16" });

		await writer.write(createSine(64, 1, SAMPLE_RATE, 440, 0.75));

		const unlinkSpy = vi.spyOn(fsPromises, "unlink");

		vi.spyOn(fsPromises, "rename").mockRejectedValue(new Error("rename failed"));

		await expect(writer.close()).rejects.toThrow(`Failed to replace "${path}" with`);

		expect(await fsPromises.readFile(path, "utf8")).toBe("original-bytes");
		expect(unlinkSpy.mock.calls.some((call) => call[0] === path)).toBe(false);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});
});
