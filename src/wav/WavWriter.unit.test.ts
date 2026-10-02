import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoise, createSine } from "../utils/testSignals";
import { BLOCK_FRAMES, WavReader, type AudioBlock } from "./WavReader";
import { bytesPerSampleOf } from "./utils/sampleCodec";
import { WavWriter, type WavSink } from "./WavWriter";
import type { WavBitDepth } from "./utils/wavFormat";

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

const legacyHeaderOf = (dataSize: number, channelCount: number, bitDepth: WavBitDepth): Buffer => {
	const header = Buffer.alloc(44);
	const bytesPerSample = bytesPerSampleOf(bitDepth);
	const blockAlign = channelCount * bytesPerSample;

	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataSize, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(bitDepth === "32f" ? 3 : 1, 20);
	header.writeUInt16LE(channelCount, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bytesPerSample * 8, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataSize, 40);

	return header;
};

const writeAll = async (
	sink: WavSink,
	format: { channelCount: number; channelMask: number; bitDepth: WavBitDepth },
	channels: ReadonlyArray<Float64Array>,
): Promise<void> => {
	const writer = await WavWriter.create(sink, {
		sampleRate: SAMPLE_RATE,
		frameCount: channels[0]?.length ?? 0,
		...format,
	});

	await writer.write(channels);
	await writer.close();
};

const fileWriterOf = async (
	path: string,
	format: { channelCount: number; bitDepth: WavBitDepth; frameCount: number; channelMask?: number },
): Promise<WavWriter> =>
	WavWriter.create({ kind: "file", path }, { sampleRate: SAMPLE_RATE, channelMask: 0, ...format });

const temporaryNamesOf = async (directory: string): Promise<Array<string>> => {
	const names = await fsPromises.readdir(directory);

	return names.filter((name) => name.endsWith(".tmp"));
};

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
		const writer = await fileWriterOf(path, { channelCount, bitDepth, frameCount: 256 });

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
		const writer = await fileWriterOf(path, { channelCount: 1, bitDepth: "16", frameCount: 64 });

		await writer.write(createSine(64, 1, SAMPLE_RATE, 440, 0.75));

		expect(existsSync(path)).toBe(false);
		expect(await temporaryNamesOf(workingDirectory)).toHaveLength(1);

		await writer.close();

		expect(existsSync(path)).toBe(true);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("abort leaves no destination and no temporary file", async () => {
		const path = join(workingDirectory, "aborted.wav");
		const writer = await fileWriterOf(path, { channelCount: 1, bitDepth: "24", frameCount: 32 });

		await writer.write(createNoise(32, 1, 3));
		await writer.abort();

		expect(existsSync(path)).toBe(false);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("supports in-place processing: original readable until close, output correct after", async () => {
		const path = join(workingDirectory, "inplace.wav");
		const original = createSine(128, 2, SAMPLE_RATE, 220, 0.75);
		const replacement = createNoise(128, 2, 21);
		const originalWriter = await fileWriterOf(path, { channelCount: 2, bitDepth: "32f", frameCount: 128 });

		await originalWriter.write(original);
		await originalWriter.close();

		const reader = await WavReader.open(path);
		const writer = await fileWriterOf(path, { channelCount: 2, bitDepth: "32f", frameCount: 128 });

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
		const originalWriter = await fileWriterOf(path, { channelCount: 1, bitDepth: "32f", frameCount: 64 });

		await originalWriter.write(original);
		await originalWriter.close();

		const writer = await fileWriterOf(path, { channelCount: 1, bitDepth: "32f", frameCount: 64 });

		await writer.write(createNoise(64, 1, 5));
		await writer.abort();

		expect(existsSync(path)).toBe(true);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);

		const read = await readAll(path);

		expectChannelsMatch(read.channels, original, "32f");
	});

	it("throws on channel-count mismatch with the stated message", async () => {
		const path = join(workingDirectory, "mismatch.wav");
		const writer = await fileWriterOf(path, { channelCount: 2, bitDepth: "16", frameCount: 8 });

		await expect(writer.write([new Float64Array(8)])).rejects.toThrow(
			"Channel count mismatch: expected 2, received 1",
		);

		await writer.abort();
	});

	it("ends an odd data chunk at the last sample byte and round-trips 5-frame 24-bit mono", async () => {
		const path = join(workingDirectory, "odd-24.wav");
		const channels = createSine(5, 1, SAMPLE_RATE, 440, 0.75);
		const writer = await fileWriterOf(path, { channelCount: 1, bitDepth: "24", frameCount: 5 });

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

		const writer = await fileWriterOf(path, { channelCount: 1, bitDepth: "16", frameCount: 64 });

		await writer.write(createSine(64, 1, SAMPLE_RATE, 440, 0.75));

		const unlinkSpy = vi.spyOn(fsPromises, "unlink");

		vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("rename failed"));

		await expect(writer.close()).rejects.toThrow(`Failed to replace "${path}" with`);

		expect(await fsPromises.readFile(path, "utf8")).toBe("original-bytes");
		expect(unlinkSpy.mock.calls.some((call) => call[0] === path)).toBe(false);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
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
	] as const)(
		"writes the 44-byte plain header for %s with %i channel(s) and mask 0",
		async (bitDepth, channelCount) => {
			const path = join(workingDirectory, `plain-${bitDepth}-${channelCount}.wav`);
			const channels = createNoise(37, channelCount, 7);

			await writeAll({ kind: "file", path }, { channelCount, channelMask: 0, bitDepth }, channels);

			const bytes = await fsPromises.readFile(path);
			const dataSize = bytes.length - 44;

			expect(dataSize).toBe(37 * channelCount * bytesPerSampleOf(bitDepth));
			expect(bytes.subarray(0, 44)).toEqual(legacyHeaderOf(dataSize, channelCount, bitDepth));
		},
	);

	it.each([
		[6, 0x3f, "24"],
		[6, 0x3f, "32f"],
		[2, 0x600, "16"],
		[3, 0, "32"],
	] as const)(
		"round-trips %i channels with mask %i through WAVE_FORMAT_EXTENSIBLE",
		async (channelCount, channelMask, bitDepth) => {
			const path = join(workingDirectory, `extensible-${channelCount}-${channelMask}.wav`);
			const channels = createNoise(300, channelCount, 13);

			await writeAll({ kind: "file", path }, { channelCount, channelMask, bitDepth }, channels);

			const bytes = await fsPromises.readFile(path);
			const read = await readAll(path);

			expect(bytes.readUInt16LE(20)).toBe(0xfffe);
			expect(read.format).toEqual({ sampleRate: SAMPLE_RATE, channelCount, channelMask, bitDepth, frameCount: 300 });
			expectChannelsMatch(read.channels, channels, bitDepth);
		},
	);

	it.each([
		[1, 0, "16"],
		[2, 0x600, "24"],
		[6, 0x3f, "32f"],
	] as const)(
		"writes %i channel(s) with mask %i to a stream sink byte-identically to a file sink",
		async (channelCount, channelMask, bitDepth) => {
			const path = join(workingDirectory, `sink-${channelCount}.wav`);
			const stream = new PassThrough();
			const chunks: Array<Buffer> = [];
			const channels = createNoise(70000, channelCount, 17);

			stream.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
			});

			await writeAll({ kind: "file", path }, { channelCount, channelMask, bitDepth }, channels);
			await writeAll({ kind: "stream", stream }, { channelCount, channelMask, bitDepth }, channels);

			expect(Buffer.concat(chunks).equals(await fsPromises.readFile(path))).toBe(true);
		},
	);

	it.each([
		[2, 0x600, "24"],
		[6, 0x3f, "32f"],
	] as const)(
		"writes %i channels with mask %i in reader blocks to a backpressured stream byte-identically to a file sink",
		async (channelCount, channelMask, bitDepth) => {
			const path = join(workingDirectory, `backpressure-${channelCount}.wav`);
			const chunks: Array<Buffer> = [];
			const stream = new Writable({
				highWaterMark: 1024,
				write: (chunk: Buffer, _encoding, callback) => {
					chunks.push(chunk);
					setTimeout(callback, 1);
				},
			});
			const frameCount = 2 * BLOCK_FRAMES + 1000;
			const channels = createNoise(frameCount, channelCount, 19);
			const format = { sampleRate: SAMPLE_RATE, frameCount, channelCount, channelMask, bitDepth };

			await writeAll({ kind: "file", path }, { channelCount, channelMask, bitDepth }, channels);

			const writer = await WavWriter.create({ kind: "stream", stream }, format);

			for (let frameIndex = 0; frameIndex < frameCount; frameIndex += BLOCK_FRAMES) {
				await writer.write(channels.map((channel) => channel.subarray(frameIndex, frameIndex + BLOCK_FRAMES)));
			}

			await writer.close();

			expect(chunks).toHaveLength(4);
			expect(Buffer.concat(chunks).equals(await fsPromises.readFile(path))).toBe(true);
		},
	);

	it("rejects the final write to a stream sink whose write callback fails after write returned true", async () => {
		let chunkCount = 0;
		const stream = new Writable({
			highWaterMark: 1 << 20,
			write: (_chunk, _encoding, callback) => {
				chunkCount++;
				setImmediate(() => {
					callback(chunkCount === 2 ? new Error("write EIO") : null);
				});
			},
		});
		const writer = await WavWriter.create(
			{ kind: "stream", stream },
			{ sampleRate: SAMPLE_RATE, channelCount: 1, channelMask: 0, bitDepth: "16", frameCount: 8 },
		);

		await expect(writer.write(createNoise(8, 1, 3))).rejects.toThrow("write EIO");
	});

	it("rejects a close short of the declared frame count and leaves no output", async () => {
		const path = join(workingDirectory, "short.wav");
		const writer = await fileWriterOf(path, { channelCount: 1, bitDepth: "16", frameCount: 10 });

		await writer.write(createNoise(9, 1, 2));

		await expect(writer.close()).rejects.toThrow(
			"Frame count mismatch: the header declares 10 frames, 9 were written",
		);
		expect(existsSync(path)).toBe(false);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("rejects a write past the declared frame count", async () => {
		const path = join(workingDirectory, "overrun.wav");
		const writer = await fileWriterOf(path, { channelCount: 1, bitDepth: "16", frameCount: 4 });

		await expect(writer.write(createNoise(5, 1, 2))).rejects.toThrow(
			"Frame count overrun: the header declares 4 frames, received 5",
		);

		await writer.abort();
	});
});
