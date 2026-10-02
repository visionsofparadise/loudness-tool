import { bytesPerSampleOf } from "./sampleCodec";
import {
	WAVE_FORMAT_EXTENSIBLE,
	WAVE_FORMAT_EXTENSIBLE_EXTENSION_SIZE,
	WAVE_FORMAT_IEEE_FLOAT,
	WAVE_FORMAT_PCM,
	type SourceBitDepth,
} from "./wavFormat";

export interface WavHeaderFormat {
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly channelMask: number;
	readonly bitDepth: SourceBitDepth;
	readonly blockAlign: number;
}

const RIFF_SIZE_LIMIT = 0xffffffff;
const BYTE_RATE_LIMIT = 0xffffffff;
const RIFF_PREAMBLE_SIZE = 12;
const CHUNK_HEADER_SIZE = 8;
const PLAIN_FORMAT_SIZE = 16;
const EXTENSIBLE_FORMAT_SIZE = 40;
const DS64_SIZE = 28;
const SUBFORMAT_GUID_TAIL = Buffer.from([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);

const formatChunkOf = (format: WavHeaderFormat, isExtensible: boolean): Buffer => {
	const { sampleRate, channelCount, channelMask, bitDepth, blockAlign } = format;
	const formatSize = isExtensible ? EXTENSIBLE_FORMAT_SIZE : PLAIN_FORMAT_SIZE;
	const chunk = Buffer.alloc(CHUNK_HEADER_SIZE + formatSize);
	const bitsPerSample = bytesPerSampleOf(bitDepth) * 8;
	const audioFormat = bitDepth === "32f" || bitDepth === "64f" ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;

	chunk.write("fmt ", 0);
	chunk.writeUInt32LE(formatSize, 4);
	chunk.writeUInt16LE(isExtensible ? WAVE_FORMAT_EXTENSIBLE : audioFormat, 8);
	chunk.writeUInt16LE(channelCount, 10);
	chunk.writeUInt32LE(sampleRate, 12);
	chunk.writeUInt32LE(Math.min(sampleRate * blockAlign, BYTE_RATE_LIMIT), 16);
	chunk.writeUInt16LE(blockAlign, 20);
	chunk.writeUInt16LE(bitsPerSample, 22);

	if (isExtensible) {
		chunk.writeUInt16LE(WAVE_FORMAT_EXTENSIBLE_EXTENSION_SIZE, 24);
		chunk.writeUInt16LE(bitsPerSample, 26);
		chunk.writeUInt32LE(channelMask >>> 0, 28);
		chunk.writeUInt32LE(audioFormat, 32);
		SUBFORMAT_GUID_TAIL.copy(chunk, 36);
	}

	return chunk;
};

const sizeChunkOf = (sizes: { riffSize: number; dataSize: number; sampleCount: number } | undefined): Buffer => {
	const chunk = Buffer.alloc(CHUNK_HEADER_SIZE + DS64_SIZE);

	chunk.write(sizes === undefined ? "JUNK" : "ds64", 0);
	chunk.writeUInt32LE(DS64_SIZE, 4);

	if (sizes !== undefined) {
		chunk.writeBigUInt64LE(BigInt(sizes.riffSize), 8);
		chunk.writeBigUInt64LE(BigInt(sizes.dataSize), 16);
		chunk.writeBigUInt64LE(BigInt(sizes.sampleCount), 24);
		chunk.writeUInt32LE(0, 32);
	}

	return chunk;
};

const headerOf = (
	format: WavHeaderFormat,
	dataSize: number,
	layout: { readonly isExtensible: boolean; readonly reservesSizeChunk: boolean },
): Buffer => {
	const formatChunk = formatChunkOf(format, layout.isExtensible);
	const riffSizeOf = (hasSizeChunk: boolean): number =>
		RIFF_PREAMBLE_SIZE +
		(hasSizeChunk ? CHUNK_HEADER_SIZE + DS64_SIZE : 0) +
		formatChunk.length +
		CHUNK_HEADER_SIZE -
		8 +
		dataSize;
	const isRf64 = riffSizeOf(layout.reservesSizeChunk) > RIFF_SIZE_LIMIT;
	const hasSizeChunk = layout.reservesSizeChunk || isRf64;
	const riffSize = riffSizeOf(hasSizeChunk);
	const preamble = Buffer.alloc(RIFF_PREAMBLE_SIZE);
	const dataChunkHeader = Buffer.alloc(CHUNK_HEADER_SIZE);
	const sizeChunk = hasSizeChunk
		? sizeChunkOf(isRf64 ? { riffSize, dataSize, sampleCount: Math.floor(dataSize / format.blockAlign) } : undefined)
		: Buffer.alloc(0);

	preamble.write(isRf64 ? "RF64" : "RIFF", 0);
	preamble.writeUInt32LE(isRf64 ? RIFF_SIZE_LIMIT : riffSize, 4);
	preamble.write("WAVE", 8);
	dataChunkHeader.write("data", 0);
	dataChunkHeader.writeUInt32LE(isRf64 ? RIFF_SIZE_LIMIT : dataSize, 4);

	return Buffer.concat([preamble, sizeChunk, formatChunk, dataChunkHeader]);
};

export const wavHeaderOf = (format: WavHeaderFormat, dataSize: number): Buffer =>
	headerOf(format, dataSize, {
		isExtensible: format.channelCount > 2 || format.channelMask !== 0,
		reservesSizeChunk: false,
	});

export const spoolHeaderOf = (format: WavHeaderFormat, dataSize: number): Buffer =>
	headerOf(format, dataSize, { isExtensible: true, reservesSizeChunk: true });
