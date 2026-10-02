import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNoise } from "../utils/testSignals";
import { encodePlanar, writeExtensibleWav } from "../utils/testWav";
import { bytesPerSampleOf } from "./utils/sampleCodec";
import { spoolHeaderOf, type WavHeaderFormat } from "./utils/wavHeader";
import { WavReader, type AudioBlock } from "./WavReader";
import { WavSpool } from "./WavSpool";
import type { SourceBitDepth } from "./utils/wavFormat";

const SAMPLE_RATE = 44100;
const FRAME_COUNT = 1001;

const readAll = async (path: string): Promise<{ format: WavReader["format"]; blocks: Array<AudioBlock> }> => {
	const reader = await WavReader.open(path);
	const blocks: Array<AudioBlock> = [];

	for await (const block of reader.blocks()) {
		blocks.push(block);
	}

	await reader.close();

	return { format: reader.format, blocks };
};

const spoolOf = async (args: {
	path: string;
	channelCount: number;
	channelMask: number;
	bitDepth: SourceBitDepth;
	bytes: Buffer;
	blockAlign: number;
}): Promise<void> => {
	const { path, channelCount, channelMask, bitDepth, bytes, blockAlign } = args;
	const spool = await WavSpool.create(
		path,
		{ sampleRate: SAMPLE_RATE, channelCount, channelMask, bitDepth },
		blockAlign,
	);

	for (let offset = 0; offset < bytes.length; offset += 777) {
		await spool.append(bytes.subarray(offset, offset + 777));
	}

	await spool.close();
};

describe("WavSpool", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-wav-spool-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it.each([
		["16", 2, 0x3],
		["24", 6, 0x3f],
		["8", 1, 0x4],
		["64f", 3, 0x10b],
		["32f", 2, 0x600],
		["32", 2, 0],
	] as const)(
		"replays %s bytes on %i channels with mask %i as the reader decodes them",
		async (bitDepth, channelCount, channelMask) => {
			const spoolPath = join(workingDirectory, "spool.wav");
			const referencePath = join(workingDirectory, "reference.wav");
			const channels = createNoise(FRAME_COUNT, channelCount, 41);

			await spoolOf({
				path: spoolPath,
				channelCount,
				channelMask,
				bitDepth,
				bytes: encodePlanar(channels, bitDepth),
				blockAlign: channelCount * bytesPerSampleOf(bitDepth),
			});
			await writeExtensibleWav(referencePath, {
				sampleRate: SAMPLE_RATE,
				channelCount,
				bitDepth,
				channelMask,
				channels,
			});

			const spooled = await readAll(spoolPath);
			const reference = await readAll(referencePath);

			expect(spooled.format).toEqual({
				sampleRate: SAMPLE_RATE,
				channelCount,
				channelMask,
				bitDepth,
				frameCount: FRAME_COUNT,
			});
			expect(spooled.blocks).toEqual(reference.blocks);
		},
	);

	it("replays under a blockAlign wider than its samples", async () => {
		const spoolPath = join(workingDirectory, "padded.wav");
		const referencePath = join(workingDirectory, "reference.wav");
		const channels = createNoise(FRAME_COUNT, 2, 43);
		const blockAlign = 2 * 3 + 2;

		await spoolOf({
			path: spoolPath,
			channelCount: 2,
			channelMask: 0x3,
			bitDepth: "24",
			bytes: encodePlanar(channels, "24", blockAlign),
			blockAlign,
		});
		await writeExtensibleWav(referencePath, {
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			bitDepth: "24",
			channelMask: 0x3,
			channels,
		});

		const spooled = await readAll(spoolPath);
		const reference = await readAll(referencePath);
		const bytes = await readFile(spoolPath);

		expect(bytes.readUInt16LE(12 + 36 + 8 + 12)).toBe(blockAlign);
		expect(spooled.format.frameCount).toBe(FRAME_COUNT);
		expect(spooled.blocks).toEqual(reference.blocks);
	});

	it("replays a stride whose sampleRate × blockAlign passes 32 bits", async () => {
		const path = join(workingDirectory, "wide.wav");
		const spool = await WavSpool.create(
			path,
			{ sampleRate: 384000, channelCount: 2, channelMask: 0x3, bitDepth: "16" },
			65535,
		);

		await spool.append(Buffer.alloc(65535 * 2));
		await spool.close();

		const bytes = await readFile(path);
		const spooled = await readAll(path);

		expect(bytes.readUInt32LE(12 + 36 + 8 + 8)).toBe(0xffffffff);
		expect(spooled.format).toEqual({
			sampleRate: 384000,
			channelCount: 2,
			channelMask: 0x3,
			bitDepth: "16",
			frameCount: 2,
		});
	});

	it("writes a JUNK placeholder ahead of the EXTENSIBLE fmt and patches the sizes at close", async () => {
		const path = join(workingDirectory, "sizes.wav");

		await spoolOf({
			path,
			channelCount: 1,
			channelMask: 0,
			bitDepth: "8",
			bytes: Buffer.alloc(5, 0x80),
			blockAlign: 1,
		});

		const bytes = await readFile(path);

		expect(bytes).toHaveLength(104 + 5);
		expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
		expect(bytes.readUInt32LE(4)).toBe(104 - 8 + 5);
		expect(bytes.toString("ascii", 12, 16)).toBe("JUNK");
		expect(bytes.readUInt32LE(16)).toBe(28);
		expect(bytes.toString("ascii", 48, 52)).toBe("fmt ");
		expect(bytes.readUInt16LE(56)).toBe(0xfffe);
		expect(bytes.toString("ascii", 96, 100)).toBe("data");
		expect(bytes.readUInt32LE(100)).toBe(5);
	});

	it("upgrades the placeholder in place to RF64 once the RIFF size passes 0xffffffff", () => {
		const format: WavHeaderFormat = {
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			channelMask: 0x3,
			bitDepth: "16",
			blockAlign: 4,
		};
		const riffDataLimit = 0xffffffff - (104 - 8);
		const fitting = spoolHeaderOf(format, riffDataLimit);
		const dataSize = riffDataLimit + 1;
		const upgraded = spoolHeaderOf(format, dataSize);

		expect(fitting.toString("ascii", 0, 4)).toBe("RIFF");
		expect(fitting.toString("ascii", 12, 16)).toBe("JUNK");
		expect(fitting.readUInt32LE(4)).toBe(0xffffffff);
		expect(upgraded).toHaveLength(fitting.length);
		expect(upgraded.toString("ascii", 0, 4)).toBe("RF64");
		expect(upgraded.readUInt32LE(4)).toBe(0xffffffff);
		expect(upgraded.toString("ascii", 12, 16)).toBe("ds64");
		expect(upgraded.readUInt32LE(16)).toBe(28);
		expect(upgraded.readBigUInt64LE(20)).toBe(BigInt(104 - 8 + dataSize));
		expect(upgraded.readBigUInt64LE(28)).toBe(BigInt(dataSize));
		expect(upgraded.readBigUInt64LE(36)).toBe(BigInt(Math.floor(dataSize / 4)));
		expect(upgraded.readUInt32LE(44)).toBe(0);
		expect(upgraded.subarray(48, 96)).toEqual(fitting.subarray(48, 96));
		expect(upgraded.toString("ascii", 96, 100)).toBe("data");
		expect(upgraded.readUInt32LE(100)).toBe(0xffffffff);
	});

	it("abort leaves no spool and no temporary file", async () => {
		const path = join(workingDirectory, "aborted.wav");
		const spool = await WavSpool.create(
			path,
			{ sampleRate: SAMPLE_RATE, channelCount: 1, channelMask: 0, bitDepth: "16" },
			2,
		);

		await spool.append(Buffer.alloc(16));
		await spool.abort();

		expect(existsSync(path)).toBe(false);
		expect(await readdir(workingDirectory)).toEqual([]);
	});
});
