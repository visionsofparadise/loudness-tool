import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoise } from "../utils/testSignals";
import { encodePlanar } from "../utils/testWav";
import { bytesPerSampleOf } from "./utils/sampleCodec";
import { TemporaryFile } from "./utils/TemporaryFile";
import { spoolHeaderOf } from "./utils/wavHeader";
import { BLOCK_FRAMES, WavReader, type AudioBlock, type BlockSource } from "./WavReader";
import { WavSpool } from "./WavSpool";
import { WavStreamReader } from "./WavStreamReader";
import type { SourceBitDepth } from "./utils/wavFormat";

const SAMPLE_RATE = 48000;
const SPOOL_HEADER_SIZE = 104;
const DATA_HEADER_OFFSET = 96;
const LIST_CHUNK = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
const ODD_CHUNK = Buffer.concat([Buffer.from("odd "), Buffer.from([3, 0, 0, 0]), Buffer.from([1, 2, 3, 0])]);
const LARGE_TRAILING_SIZE = 2 * 1024 * 1024;
const LARGE_LIST_CHUNK = Buffer.alloc(8 + LARGE_TRAILING_SIZE);

LARGE_LIST_CHUNK.write("LIST", 0);
LARGE_LIST_CHUNK.writeUInt32LE(LARGE_TRAILING_SIZE, 4);

interface WavBytes {
	readonly file: Buffer;
	readonly data: Buffer;
}

const wavBytesOf = (args: {
	channels: ReadonlyArray<Float64Array>;
	bitDepth: SourceBitDepth;
	channelMask?: number;
	frameStride?: number;
	dataSizeField?: number;
	ds64DataSize?: number;
	isRf64?: boolean;
	beforeData?: Buffer;
	afterData?: Buffer;
}): WavBytes => {
	const { channels, bitDepth } = args;
	const channelCount = channels.length;
	const blockAlign = args.frameStride ?? channelCount * bytesPerSampleOf(bitDepth);
	const data = encodePlanar(channels, bitDepth, args.frameStride);
	const header = spoolHeaderOf(
		{ sampleRate: SAMPLE_RATE, channelCount, channelMask: args.channelMask ?? 0, bitDepth, blockAlign },
		data.length,
	);
	const dataHeader = Buffer.from(header.subarray(DATA_HEADER_OFFSET));
	const file = Buffer.concat([
		header.subarray(0, DATA_HEADER_OFFSET),
		args.beforeData ?? Buffer.alloc(0),
		dataHeader,
		data,
		args.afterData ?? Buffer.alloc(0),
	]);
	const dataSizeOffset = file.length - data.length - (args.afterData?.length ?? 0) - 4;

	if (args.isRf64 === true) {
		file.write("RF64", 0);
		file.writeUInt32LE(0xffffffff, 4);
		file.write("ds64", 12);
		file.writeBigUInt64LE(BigInt(file.length - 8), 20);
		file.writeBigUInt64LE(BigInt(args.ds64DataSize ?? data.length), 28);
		file.writeBigUInt64LE(BigInt(channels[0]?.length ?? 0), 36);
		file.writeUInt32LE(0, 44);
		file.writeUInt32LE(0xffffffff, dataSizeOffset);
	} else {
		file.writeUInt32LE(file.length - 8, 4);
		file.writeUInt32LE(args.dataSizeField ?? data.length, dataSizeOffset);
	}

	return { file, data };
};

const feed = (bytes: Buffer, writeSize: number): { stream: PassThrough; isFed: Promise<void> } => {
	const stream = new PassThrough();
	const isFed = (async (): Promise<void> => {
		for (let offset = 0; offset < bytes.length; offset += writeSize) {
			if (!stream.write(bytes.subarray(offset, offset + writeSize))) {
				await new Promise((resolve) => stream.once("drain", resolve));
			}
		}

		stream.end();
	})();

	return { stream, isFed };
};

const collect = async (source: BlockSource): Promise<Array<AudioBlock>> => {
	const blocks: Array<AudioBlock> = [];

	for await (const block of source.blocks()) {
		blocks.push(block);
	}

	return blocks;
};

const blockFramesOf = (blocks: ReadonlyArray<AudioBlock>): Array<number> =>
	blocks.map((block) => block.channels[0]?.length ?? 0);

describe("WavStreamReader", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-wav-stream-reader-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const readFileBlocks = async (
		bytes: Buffer,
	): Promise<{ format: WavReader["format"]; blocks: Array<AudioBlock> }> => {
		const path = join(workingDirectory, "reference.wav");

		await writeFile(path, bytes);

		const reader = await WavReader.open(path);

		try {
			return { format: reader.format, blocks: await collect(reader) };
		} finally {
			await reader.close();
		}
	};

	const readStreamBlocks = async (
		bytes: Buffer,
		writeSize: number,
		spoolPath?: string,
	): Promise<{ reader: WavStreamReader; blocks: Array<AudioBlock> }> => {
		const { stream, isFed } = feed(bytes, writeSize);
		const reader = await WavStreamReader.open(
			stream,
			spoolPath === undefined
				? undefined
				: async (format, blockAlign) => WavSpool.create(spoolPath, format, blockAlign),
		);

		try {
			const blocks = await collect(reader);

			await isFed;

			return { reader, blocks };
		} finally {
			await reader.close();
		}
	};

	describe.each([
		["1-byte", 1],
		["7-byte", 7],
		["whole-file", Number.MAX_SAFE_INTEGER],
	])("fed in %s writes", (_label, writeSize) => {
		it.each([
			["16", 2, 0, undefined],
			["24", 6, 0x3f, undefined],
			["8", 1, 0, undefined],
			["64f", 3, 0x10b, undefined],
			["32f", 2, 0x600, 12],
			["32", 2, 0, undefined],
		] as const)(
			"decodes %s bytes on %i channels with mask %i and stride %s as WavReader does",
			async (bitDepth, channelCount, channelMask, frameStride) => {
				const { file } = wavBytesOf({
					channels: createNoise(1001, channelCount, 17),
					bitDepth,
					channelMask,
					frameStride,
				});
				const expected = await readFileBlocks(file);
				const { reader, blocks } = await readStreamBlocks(file, writeSize);
				const { frameCount: _frameCount, ...streamFormat } = expected.format;

				expect(reader.format).toEqual(streamFormat);
				expect(blocks).toEqual(expected.blocks);
			},
		);

		it.each([
			["8", 1, 2 * BLOCK_FRAMES + 5],
			["16", 2, 2 * BLOCK_FRAMES],
			["16", 1, BLOCK_FRAMES + 1],
		] as const)(
			"yields the file reader's block frame counts for %s bytes on %i channels over %i frames",
			async (bitDepth, channelCount, frameCount) => {
				const { file } = wavBytesOf({ channels: createNoise(frameCount, channelCount, 5), bitDepth });
				const expected = await readFileBlocks(file);
				const { blocks } = await readStreamBlocks(file, writeSize);

				expect(blockFramesOf(blocks)).toEqual(blockFramesOf(expected.blocks));
				expect(blocks).toEqual(expected.blocks);
			},
		);
	});

	it("drops the final partial frame as the file reader does", async () => {
		const { file } = wavBytesOf({
			channels: createNoise(300, 2, 3),
			bitDepth: "16",
			afterData: Buffer.from([1, 2, 3]),
			dataSizeField: 300 * 4 + 3,
		});
		const expected = await readFileBlocks(file);
		const { blocks } = await readStreamBlocks(file, 7);

		expect(blockFramesOf(blocks)).toEqual([300]);
		expect(blocks).toEqual(expected.blocks);
	});

	it("reads a 0xFFFFFFFF data size to the end of the stream", async () => {
		const { file } = wavBytesOf({ channels: createNoise(5000, 2, 9), bitDepth: "24", dataSizeField: 0xffffffff });
		const expected = await readFileBlocks(file);
		const { blocks } = await readStreamBlocks(file, 7);

		expect(blockFramesOf(blocks)).toEqual([5000]);
		expect(blocks).toEqual(expected.blocks);
	});

	it("reads a declared data size of zero as empty and drains the audio after it", async () => {
		const { file } = wavBytesOf({ channels: createNoise(5000, 2, 9), bitDepth: "16", dataSizeField: 0 });
		const { reader, blocks } = await readStreamBlocks(file, 7);

		expect(blocks).toEqual([]);
		expect(reader.hasReachedEnd).toBe(true);
	});

	it("reads a declared size, clamped to the bytes present, and drains a trailing chunk", async () => {
		const declared = wavBytesOf({ channels: createNoise(700, 1, 4), bitDepth: "16", afterData: LIST_CHUNK });
		const truncated = wavBytesOf({ channels: createNoise(700, 1, 4), bitDepth: "16", dataSizeField: 2000 * 2 });

		expect(blockFramesOf((await readStreamBlocks(declared.file, 7)).blocks)).toEqual([700]);
		expect((await readStreamBlocks(truncated.file, 7)).blocks).toEqual((await readFileBlocks(truncated.file)).blocks);
	});

	it("drains a trailing chunk far larger than the stream's buffers to the end of the stream", async () => {
		const { file } = wavBytesOf({ channels: createNoise(700, 2, 4), bitDepth: "16", afterData: LARGE_LIST_CHUNK });
		const { stream, isFed } = feed(file, 65536);
		const reader = await WavStreamReader.open(stream);

		try {
			expect(blockFramesOf(await collect(reader))).toEqual([700]);
			expect(stream.readableEnded).toBe(true);
			expect(reader.hasReachedEnd).toBe(true);

			await isFed;
		} finally {
			await reader.close();
		}
	});

	it("takes an RF64 data size from ds64 and drains the bytes after it", async () => {
		const { file } = wavBytesOf({
			channels: createNoise(900, 2, 8),
			bitDepth: "32f",
			isRf64: true,
			ds64DataSize: 800 * 8,
			afterData: Buffer.alloc(37),
		});
		const expected = await readFileBlocks(file);
		const { blocks } = await readStreamBlocks(file, 7);

		expect(blockFramesOf(blocks)).toEqual([800]);
		expect(blocks).toEqual(expected.blocks);
	});

	it("skips an odd-sized chunk and its pad byte before the data", async () => {
		const { file } = wavBytesOf({ channels: createNoise(400, 2, 6), bitDepth: "16", beforeData: ODD_CHUNK });
		const expected = await readFileBlocks(file);
		const { blocks } = await readStreamBlocks(file, 1);

		expect(blocks).toEqual(expected.blocks);
	});

	it("spools byte-equal data that replays through WavReader", async () => {
		const spoolPath = join(workingDirectory, "spool.wav");
		const { file, data } = wavBytesOf({
			channels: createNoise(BLOCK_FRAMES + 333, 3, 12),
			bitDepth: "24",
			channelMask: 0x10b,
			afterData: LIST_CHUNK,
		});
		const { blocks } = await readStreamBlocks(file, 4093, spoolPath);
		const spool = await readFile(spoolPath);
		const replay = await readFileBlocks(spool);

		expect(spool.subarray(SPOOL_HEADER_SIZE).equals(data)).toBe(true);
		expect(replay.format.channelMask).toBe(0x10b);
		expect(replay.blocks).toEqual(blocks);
	});

	it("aborts the spool and stops reading when closed before the end", async () => {
		const spoolPath = join(workingDirectory, "spool.wav");
		const { file } = wavBytesOf({ channels: createNoise(2 * BLOCK_FRAMES, 1, 2), bitDepth: "16" });
		const { stream } = feed(file, 65536);
		const reader = await WavStreamReader.open(stream, async (format, blockAlign) =>
			WavSpool.create(spoolPath, format, blockAlign),
		);

		for await (const _block of reader.blocks()) {
			break;
		}

		await reader.close();

		expect(reader.hasReachedEnd).toBe(false);
		expect(existsSync(spoolPath)).toBe(false);
		expect(await readdir(workingDirectory)).toEqual([]);
		expect(stream.destroyed).toBe(true);
	});

	it("discards the spool when finalizing its header fails", async () => {
		const spoolPath = join(workingDirectory, "spool.wav");
		const { file } = wavBytesOf({ channels: createNoise(500, 1, 2), bitDepth: "16" });
		const { stream } = feed(file, 65536);
		const reader = await WavStreamReader.open(stream, async (format, blockAlign) =>
			WavSpool.create(spoolPath, format, blockAlign),
		);

		await collect(reader);

		const write = vi.spyOn(TemporaryFile.prototype, "write").mockRejectedValue(new Error("disk full"));
		const discard = vi.spyOn(TemporaryFile.prototype, "discard");

		try {
			await expect(reader.close()).rejects.toThrow("disk full");
			expect(discard).toHaveBeenCalledOnce();
			expect(await readdir(workingDirectory)).toEqual([]);
		} finally {
			write.mockRestore();
			discard.mockRestore();
		}
	});

	it("rejects a stream that is not WAV", async () => {
		const { stream } = feed(Buffer.from("not a wav stream at all"), 7);

		await expect(WavStreamReader.open(stream)).rejects.toThrow("Not a WAV stream");
	});

	it("rejects a stream that ends before its data chunk", async () => {
		const { file } = wavBytesOf({ channels: createNoise(10, 1, 1), bitDepth: "16" });
		const { stream } = feed(file.subarray(0, 60), 7);

		await expect(WavStreamReader.open(stream)).rejects.toThrow("Invalid WAV stream");
	});
});
