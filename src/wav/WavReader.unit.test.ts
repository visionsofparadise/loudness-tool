import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCK_FRAMES, WavReader, type AudioBlock } from "./WavReader";
import { WavWriter } from "./WavWriter";
import { bytesPerSampleOf } from "./utils/sampleCodec";
import { createNoise, createRamp } from "../utils/testSignals";
import { encodePlanar, writeExtensibleWav } from "../utils/testWav";
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

const writeRiffWav = async (
	path: string,
	options: {
		sampleRate: number;
		channelCount: number;
		bitDepth: SourceBitDepth;
		channels: ReadonlyArray<Float64Array>;
		extraChunk?: Buffer;
		declaredDataSize?: number;
		blockAlign?: number;
		frameStride?: number;
	},
): Promise<void> => {
	const data = encodePlanar(options.channels, options.bitDepth, options.frameStride);
	const extraChunk = options.extraChunk ?? Buffer.alloc(0);
	const headerSize = 44 + extraChunk.length;
	const file = Buffer.alloc(headerSize + data.length);
	const bytesPerSample = bytesPerSampleOf(options.bitDepth);
	const blockAlign = options.blockAlign ?? options.channelCount * bytesPerSample;
	const bitsPerSample = bytesPerSample * 8;
	const audioFormat = options.bitDepth === "32f" || options.bitDepth === "64f" ? 3 : 1;
	const declaredDataSize = options.declaredDataSize ?? data.length;

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
	file.writeUInt32LE(declaredDataSize, 40 + extraChunk.length);
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
		ds64DataSize?: number;
		extraBytes?: number;
	},
): Promise<void> => {
	const data = encodePlanar(options.channels, options.bitDepth);
	const extraBytes = options.extraBytes ?? 0;
	const headerSize = 80;
	const file = Buffer.alloc(headerSize + data.length + extraBytes);
	const bytesPerSample = bytesPerSampleOf(options.bitDepth);
	const blockAlign = options.channelCount * bytesPerSample;
	const bitsPerSample = bytesPerSample * 8;
	const audioFormat = options.bitDepth === "32f" ? 3 : 1;
	const frameCount = options.channels[0]?.length ?? 0;
	const ds64DataSize = options.ds64DataSize ?? data.length;

	file.write("RF64", 0);
	file.writeUInt32LE(0xffffffff, 4);
	file.write("WAVE", 8);
	file.write("ds64", 12);
	file.writeUInt32LE(28, 16);
	file.writeBigUInt64LE(BigInt(headerSize - 8 + data.length + extraBytes), 20);
	file.writeBigUInt64LE(BigInt(ds64DataSize), 28);
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
		vi.restoreAllMocks();
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
		const writer = await WavWriter.create(
			{ kind: "file", path },
			{ sampleRate: SAMPLE_RATE, channelCount: 1, channelMask: 0, bitDepth: "32f", frameCount },
		);

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

	it.each([
		{ bitDepth: "16" as const, frameCount: 48, channelCount: 1 },
		{ bitDepth: "24" as const, frameCount: 32, channelCount: 2 },
		{ bitDepth: "32f" as const, frameCount: 16, channelCount: 1 },
	])(
		"decodes WAVE_FORMAT_EXTENSIBLE $bitDepth identically to a plain-tag twin",
		async ({ bitDepth, frameCount, channelCount }) => {
			const channels = createRamp(frameCount, channelCount);
			const plainPath = join(workingDirectory, `plain-${bitDepth}.wav`);
			const extensiblePath = join(workingDirectory, `extensible-${bitDepth}.wav`);

			await writeRiffWav(plainPath, {
				sampleRate: SAMPLE_RATE,
				channelCount,
				bitDepth,
				channels,
			});
			await writeExtensibleWav(extensiblePath, {
				sampleRate: SAMPLE_RATE,
				channelCount,
				bitDepth,
				channels,
			});

			const plain = await readAll(plainPath);
			const extensible = await readAll(extensiblePath);

			expect(extensible.format.bitDepth).toBe(bitDepth);
			expect(extensible.format.bitDepth).toBe(plain.format.bitDepth);
			expect(extensible.format.frameCount).toBe(frameCount);
			expect(extensible.format.channelCount).toBe(channelCount);
			expect(extensible.channels.length).toBe(plain.channels.length);

			for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
				expect(Array.from(extensible.channels[channelIndex] ?? [])).toEqual(
					Array.from(plain.channels[channelIndex] ?? []),
				);
			}
		},
	);

	it.each([
		{ name: "a 6-channel WAVE_FORMAT_EXTENSIBLE file", channelCount: 6, channelMask: 0x3f, isExtensible: true },
		{ name: "a plain 6-channel file", channelCount: 6, channelMask: 0, isExtensible: false },
		{ name: "a WAVE_FORMAT_EXTENSIBLE stereo file with mask 0", channelCount: 2, channelMask: 0, isExtensible: true },
	])("reads the channel mask $channelMask of $name", async ({ channelCount, channelMask, isExtensible }) => {
		const path = join(workingDirectory, "mask.wav");
		const options = {
			sampleRate: SAMPLE_RATE,
			channelCount,
			bitDepth: "16" as const,
			channels: createRamp(8, channelCount),
		};

		await (isExtensible ? writeExtensibleWav(path, { ...options, channelMask }) : writeRiffWav(path, options));

		const { format } = await readAll(path);

		expect(format).toEqual({ sampleRate: SAMPLE_RATE, channelCount, channelMask, bitDepth: "16", frameCount: 8 });
	});

	it("rejects WAVE_FORMAT_EXTENSIBLE with an unknown SubFormat GUID naming the GUID", async () => {
		const path = join(workingDirectory, "unknown-guid.wav");
		const unknownGuid = Buffer.from([
			0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
		]);

		await writeExtensibleWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "16",
			channels: createRamp(8, 1),
			subFormatGuid: unknownGuid,
		});

		await expect(WavReader.open(path)).rejects.toThrow(
			/Unsupported WAV format: audioFormat 65534, SubFormat GUID 00000004-0000-0010-8000-00aa00389b71, bitsPerSample 16/,
		);
	});

	it("reports the true duration of a plain RIFF file whose data size is the 0xFFFFFFFF streaming sentinel", async () => {
		const path = join(workingDirectory, "sentinel-ffffffff.wav");
		const frameCount = SAMPLE_RATE * 2;

		await writeRiffWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "16",
			channels: createRamp(frameCount, 1),
			declaredDataSize: 0xffffffff,
		});

		const read = await readAll(path);

		expect(read.format.frameCount).toBe(frameCount);
		expect(read.format.frameCount / read.format.sampleRate).toBe(2);
	});

	it("reads 0 frames from a data chunk declaring 0 even when audio bytes follow it", async () => {
		const path = join(workingDirectory, "declared-zero.wav");

		await writeRiffWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "16",
			channels: createRamp(47, 1),
			declaredDataSize: 0,
		});

		const read = await readAll(path);

		expect(read.format.frameCount).toBe(0);
	});

	it("reports the truncated frame count when the declared data size exceeds the bytes present", async () => {
		const path = join(workingDirectory, "truncated.wav");
		const frameCount = 25;
		const bytesPerSample = bytesPerSampleOf("16");

		await writeRiffWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "16",
			channels: createRamp(frameCount, 1),
			declaredDataSize: 1000 * bytesPerSample,
		});

		const read = await readAll(path);

		expect(read.format.frameCount).toBe(frameCount);
	});

	it("reads a padded-stride file at its declared blockAlign", async () => {
		const path = join(workingDirectory, "padded-stride.wav");
		const frameCount = 8;
		const channels = createRamp(frameCount, 1);

		await writeRiffWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "16",
			channels,
			blockAlign: 4,
			frameStride: 4,
		});

		const read = await readAll(path);

		expect(read.format.frameCount).toBe(frameCount);

		for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
			expect(Math.abs((read.channels[0]?.[frameIndex] ?? 0) - (channels[0]?.[frameIndex] ?? 0))).toBeLessThanOrEqual(
				1.5 / 0x8000,
			);
		}
	});

	it("rejects a file whose blockAlign is 0 with a named Invalid WAV file error", async () => {
		const path = join(workingDirectory, "zero-block-align.wav");

		await writeRiffWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			bitDepth: "16",
			channels: createRamp(8, 2),
			blockAlign: 0,
		});

		await expect(WavReader.open(path)).rejects.toThrow(/Invalid WAV file: blockAlign 0/);
	});

	it("rejects a file that ends inside a chunk's payload as an invalid WAV file naming its path", async () => {
		const path = join(workingDirectory, "ends-inside-fmt.wav");
		const whole = join(workingDirectory, "whole.wav");

		await writeRiffWav(whole, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "16",
			channels: createRamp(8, 1),
		});
		await writeFile(path, (await readFile(whole)).subarray(0, 30));

		await expect(WavReader.open(path)).rejects.toThrow(`Invalid WAV file: "${path}"`);
	});

	it("rejects a file whose channelCount is 0 with a named Invalid WAV file error", async () => {
		const path = join(workingDirectory, "zero-channels.wav");

		await writeRiffWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 0,
			bitDepth: "16",
			channels: [],
		});

		await expect(WavReader.open(path)).rejects.toThrow(/Invalid WAV file: channelCount 0/);
	});

	it("rejects a file whose sampleRate is 0 with a named Invalid WAV file error", async () => {
		const path = join(workingDirectory, "zero-rate.wav");

		await writeRiffWav(path, {
			sampleRate: 0,
			channelCount: 1,
			bitDepth: "16",
			channels: createRamp(8, 1),
		});

		await expect(WavReader.open(path)).rejects.toThrow(/Invalid WAV file: sampleRate 0/);
	});

	it("takes min(ds64, bytes present) for RF64 rather than the 0xFFFFFFFF data-chunk sentinel", async () => {
		const path = join(workingDirectory, "rf64-ds64-clamp.wav");
		const frameCount = 64;
		const bytesPerFrame = 2 * bytesPerSampleOf("16");
		const ds64Frames = 32;

		await writeRf64Wav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			bitDepth: "16",
			channels: createRamp(frameCount, 2),
			ds64DataSize: ds64Frames * bytesPerFrame,
			extraBytes: ds64Frames * bytesPerFrame,
		});

		const read = await readAll(path);

		expect(read.format.frameCount).toBe(ds64Frames);
	});

	it("reports the truncated frame count when rf64 ds64 exceeds the bytes present", async () => {
		const path = join(workingDirectory, "rf64-ds64-oversize.wav");
		const frameCount = 32;
		const bytesPerFrame = 2 * bytesPerSampleOf("16");
		const ds64Frames = 64;

		await writeRf64Wav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			bitDepth: "16",
			channels: createRamp(frameCount, 2),
			ds64DataSize: ds64Frames * bytesPerFrame,
		});

		const read = await readAll(path);

		expect(read.format.frameCount).toBe(frameCount);
	});

	it("caps the fmt read at 64 bytes", async () => {
		const path = join(workingDirectory, "large-fmt.wav");
		const channels = createRamp(8, 1);
		const data = encodePlanar(channels, "16");
		const fmtChunkSize = 1000;
		const headerSize = 12 + 8 + fmtChunkSize + 8;
		const file = Buffer.alloc(headerSize + data.length);
		const blockAlign = bytesPerSampleOf("16");

		file.write("RIFF", 0);
		file.writeUInt32LE(headerSize - 8 + data.length, 4);
		file.write("WAVE", 8);
		file.write("fmt ", 12);
		file.writeUInt32LE(fmtChunkSize, 16);
		file.writeUInt16LE(1, 20);
		file.writeUInt16LE(1, 22);
		file.writeUInt32LE(SAMPLE_RATE, 24);
		file.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
		file.writeUInt16LE(blockAlign, 32);
		file.writeUInt16LE(16, 34);
		file.write("data", 12 + 8 + fmtChunkSize);
		file.writeUInt32LE(data.length, 12 + 8 + fmtChunkSize + 4);
		data.copy(file, headerSize);

		await writeFile(path, file);

		const allocSpy = vi.spyOn(Buffer, "alloc");
		const reader = await WavReader.open(path);

		await reader.close();

		expect(allocSpy.mock.calls.some((call) => call[0] === 64)).toBe(true);
		expect(allocSpy.mock.calls.some((call) => call[0] === fmtChunkSize)).toBe(false);
	});

	it("rejects WAVE_FORMAT_EXTENSIBLE when the fmt chunk is too short to read the SubFormat GUID", async () => {
		const path = join(workingDirectory, "short-extensible.wav");

		await writeExtensibleWav(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "16",
			channels: createRamp(8, 1),
			cbSize: 10,
		});

		await expect(WavReader.open(path)).rejects.toThrow(
			/Invalid WAV file: WAVE_FORMAT_EXTENSIBLE fmt chunk is too short to read the SubFormat GUID/,
		);
	});

	it("leaves no temporary files after reading", async () => {
		const path = join(workingDirectory, "plain.wav");
		const writer = await WavWriter.create(
			{ kind: "file", path },
			{ sampleRate: SAMPLE_RATE, channelCount: 1, channelMask: 0, bitDepth: "16", frameCount: 8 },
		);

		await writer.write(createRamp(8, 1));
		await writer.close();

		const read = await readAll(path);

		expect(read.format.frameCount).toBe(8);

		const names = await readdir(workingDirectory);

		expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});
