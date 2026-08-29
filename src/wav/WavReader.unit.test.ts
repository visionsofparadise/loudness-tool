import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCK_FRAMES, WavReader, type AudioBlock } from "./WavReader";
import { WavWriter } from "./WavWriter";
import { bytesPerSampleOf, encodeSample } from "./utils/sampleCodec";
import { createNoise, createRamp } from "../utils/testSignals";
import { nearestWritableBitDepth, type SourceBitDepth, type WavBitDepth } from "./utils/wavFormat";

const SAMPLE_RATE = 48000;

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

const encodePlanar = (channels: ReadonlyArray<Float64Array>, bitDepth: SourceBitDepth): Buffer => {
	const frameCount = channels[0]?.length ?? 0;
	const channelCount = channels.length;
	const bytesPerSample = bytesPerSampleOf(bitDepth);
	const buffer = Buffer.alloc(frameCount * channelCount * bytesPerSample);
	let offset = 0;

	for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			const sample = channels[channelIndex]?.[frameIndex] ?? 0;

			if (bitDepth === "8") {
				const clamped = Math.max(-1, Math.min(1, sample));

				buffer[offset] = Math.max(0, Math.min(255, Math.round(clamped * 128 + 128)));
				offset += 1;
			} else if (bitDepth === "64f") {
				buffer.writeDoubleLE(sample, offset);
				offset += 8;
			} else {
				offset = encodeSample(buffer, offset, sample, bitDepth);
			}
		}
	}

	return buffer;
};

const writeRiffWav = async (
	path: string,
	options: {
		sampleRate: number;
		channelCount: number;
		bitDepth: SourceBitDepth;
		channels: ReadonlyArray<Float64Array>;
		extraChunk?: Buffer;
	},
): Promise<void> => {
	const data = encodePlanar(options.channels, options.bitDepth);
	const extraChunk = options.extraChunk ?? Buffer.alloc(0);
	const headerSize = 44 + extraChunk.length;
	const file = Buffer.alloc(headerSize + data.length);
	const bytesPerSample = bytesPerSampleOf(options.bitDepth);
	const blockAlign = options.channelCount * bytesPerSample;
	const bitsPerSample = bytesPerSample * 8;
	const audioFormat = options.bitDepth === "32f" || options.bitDepth === "64f" ? 3 : 1;

	file.write("RIFF", 0);
	file.writeUInt32LE(headerSize - 8 + data.length, 4);
	file.write("WAVE", 8);
	file.write("fmt ", 12);
	file.writeUInt32LE(16, 16);
	file.writeUInt16LE(audioFormat, 20);
	file.writeUInt16LE(options.channelCount, 22);
	file.writeUInt32LE(options.sampleRate, 24);
	file.writeUInt32LE(options.sampleRate * blockAlign, 28);
	file.writeUInt16LE(blockAlign, 32);
	file.writeUInt16LE(bitsPerSample, 34);
	extraChunk.copy(file, 36);
	file.write("data", 36 + extraChunk.length);
	file.writeUInt32LE(data.length, 40 + extraChunk.length);
	data.copy(file, headerSize);

	await writeFile(path, file);
};

const writeRf64Wav = async (
	path: string,
	options: {
		sampleRate: number;
		channelCount: number;
		bitDepth: WavBitDepth;
		channels: ReadonlyArray<Float64Array>;
	},
): Promise<void> => {
	const data = encodePlanar(options.channels, options.bitDepth);
	const headerSize = 80;
	const file = Buffer.alloc(headerSize + data.length);
	const bytesPerSample = bytesPerSampleOf(options.bitDepth);
	const blockAlign = options.channelCount * bytesPerSample;
	const bitsPerSample = bytesPerSample * 8;
	const audioFormat = options.bitDepth === "32f" ? 3 : 1;
	const frameCount = options.channels[0]?.length ?? 0;

	file.write("RF64", 0);
	file.writeUInt32LE(0xffffffff, 4);
	file.write("WAVE", 8);
	file.write("ds64", 12);
	file.writeUInt32LE(28, 16);
	file.writeBigUInt64LE(BigInt(headerSize - 8 + data.length), 20);
	file.writeBigUInt64LE(BigInt(data.length), 28);
	file.writeBigUInt64LE(BigInt(frameCount), 36);
	file.writeUInt32LE(0, 44);
	file.write("fmt ", 48);
	file.writeUInt32LE(16, 52);
	file.writeUInt16LE(audioFormat, 56);
	file.writeUInt16LE(options.channelCount, 58);
	file.writeUInt32LE(options.sampleRate, 60);
	file.writeUInt32LE(options.sampleRate * blockAlign, 64);
	file.writeUInt16LE(blockAlign, 68);
	file.writeUInt16LE(bitsPerSample, 70);
	file.write("data", 72);
	file.writeUInt32LE(0xffffffff, 76);
	data.copy(file, headerSize);

	await writeFile(path, file);
};

describe("WavReader", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-wav-reader-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("reports 8-bit depth and maps it to 16-bit writable", async () => {
		const path = join(workingDirectory, "eight.wav");
		const channels = createRamp(32, 1);

		await writeRiffWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "8",
			channels,
		});

		const read = await readAll(path);

		expect(read.format.bitDepth).toBe("8");
		expect(read.format.sampleRate).toBe(SAMPLE_RATE);
		expect(read.format.channelCount).toBe(1);
		expect(read.format.frameCount).toBe(32);
		expect(nearestWritableBitDepth(read.format.bitDepth)).toBe("16");

		for (let frameIndex = 0; frameIndex < 32; frameIndex++) {
			expect(Math.abs((read.channels[0]?.[frameIndex] ?? 0) - (channels[0]?.[frameIndex] ?? 0))).toBeLessThanOrEqual(
				1 / 128,
			);
		}
	});

	it("reports 64-bit float depth and maps it to 32f writable", async () => {
		const path = join(workingDirectory, "float64.wav");
		const channels = createRamp(16, 2);

		await writeRiffWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			bitDepth: "64f",
			channels,
		});

		const read = await readAll(path);

		expect(read.format.bitDepth).toBe("64f");
		expect(read.format.channelCount).toBe(2);
		expect(read.format.frameCount).toBe(16);
		expect(nearestWritableBitDepth(read.format.bitDepth)).toBe("32f");
		expect(Array.from(read.channels[0] ?? [])).toEqual(Array.from(channels[0] ?? []));
		expect(Array.from(read.channels[1] ?? [])).toEqual(Array.from(channels[1] ?? []));
	});

	it("skips an extra odd-sized chunk between fmt and data including the pad byte", async () => {
		const path = join(workingDirectory, "junk.wav");
		const channels = createNoise(48, 1, 7);
		const extraChunk = Buffer.alloc(12);

		extraChunk.write("JUNK", 0);
		extraChunk.writeUInt32LE(3, 4);
		extraChunk[8] = 0x11;
		extraChunk[9] = 0x22;
		extraChunk[10] = 0x33;
		extraChunk[11] = 0xaa;

		await writeRiffWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "16",
			channels,
			extraChunk,
		});

		const read = await readAll(path);

		expect(read.format.frameCount).toBe(48);
		expect(read.format.bitDepth).toBe("16");

		for (let frameIndex = 0; frameIndex < 48; frameIndex++) {
			expect(Math.abs((read.channels[0]?.[frameIndex] ?? 0) - (channels[0]?.[frameIndex] ?? 0))).toBeLessThanOrEqual(
				1.5 / 0x8000,
			);
		}
	});

	it("reads an RF64 header through the ds64 data-size path", async () => {
		const path = join(workingDirectory, "rf64.wav");
		const channels = createRamp(64, 2);

		await writeRf64Wav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			bitDepth: "16",
			channels,
		});

		const read = await readAll(path);

		expect(read.format.sampleRate).toBe(SAMPLE_RATE);
		expect(read.format.channelCount).toBe(2);
		expect(read.format.bitDepth).toBe("16");
		expect(read.format.frameCount).toBe(64);

		for (let channelIndex = 0; channelIndex < 2; channelIndex++) {
			for (let frameIndex = 0; frameIndex < 64; frameIndex++) {
				expect(
					Math.abs((read.channels[channelIndex]?.[frameIndex] ?? 0) - (channels[channelIndex]?.[frameIndex] ?? 0)),
				).toBeLessThanOrEqual(1.5 / 0x8000);
			}
		}
	});

	it("yields multi-block content with a ragged final block of freshly allocated arrays", async () => {
		const path = join(workingDirectory, "blocks.wav");
		const raggedFrames = 123;
		const frameCount = BLOCK_FRAMES + raggedFrames;
		const channels = createRamp(frameCount, 1);
		const writer = await WavWriter.create(path, { sampleRate: SAMPLE_RATE, channelCount: 1, bitDepth: "32f" });

		await writer.write(channels);
		await writer.close();

		const reader = await WavReader.open(path);
		const blocks: Array<AudioBlock> = [];

		for await (const block of reader.blocks()) {
			blocks.push(block);
		}

		await reader.close();

		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.frameIndex).toBe(0);
		expect(blocks[0]?.channels[0]?.length).toBe(BLOCK_FRAMES);
		expect(blocks[1]?.frameIndex).toBe(BLOCK_FRAMES);
		expect(blocks[1]?.channels[0]?.length).toBe(raggedFrames);

		const firstSample = blocks[0]?.channels[0]?.[0];

		if (blocks[0]?.channels[0] !== undefined) {
			blocks[0].channels[0][0] = 0.5;
		}

		expect(blocks[1]?.channels[0]?.[0]).not.toBe(0.5);
		expect(firstSample).not.toBe(0.5);

		const merged = mergeBlocks(blocks);

		if (merged[0] !== undefined && firstSample !== undefined) {
			merged[0][0] = firstSample;
		}

		for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
			expect(merged[0]?.[frameIndex]).toBe(Math.fround(channels[0]?.[frameIndex] ?? 0));
		}
	});

	it("leaves no temporary files after reading", async () => {
		const path = join(workingDirectory, "plain.wav");
		const writer = await WavWriter.create(path, { sampleRate: SAMPLE_RATE, channelCount: 1, bitDepth: "16" });

		await writer.write(createRamp(8, 1));
		await writer.close();

		const read = await readAll(path);

		expect(read.format.frameCount).toBe(8);

		const names = await readdir(workingDirectory);

		expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});
