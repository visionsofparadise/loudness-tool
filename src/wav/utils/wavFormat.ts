import type { FileHandle } from "node:fs/promises";

export type WavBitDepth = "16" | "24" | "32" | "32f";

export type SourceBitDepth = WavBitDepth | "8" | "64f";

export interface ParsedWavFormat extends WavFormatFields {
	readonly dataOffset: number;
	readonly dataSize: number;
}

export const WAVE_FORMAT_PCM = 1;
export const WAVE_FORMAT_IEEE_FLOAT = 3;
export const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
export const WAVE_FORMAT_EXTENSIBLE_EXTENSION_SIZE = 22;

const CHANNEL_MASK_OFFSET = 20;
const SUBFORMAT_GUID_OFFSET = 24;
const SUBFORMAT_GUID_SIZE = 16;
const FORMAT_READ_SIZE_LIMIT = 64;
const STREAMING_DATA_SIZE_SENTINEL = 0xffffffff;
const DS64_REQUIRED_SIZE = 16;

export const notWavErrorOf = (path: string): Error => new Error(`Not a WAV file: "${path}"`);

export const invalidWavErrorOf = (path: string): Error => new Error(`Invalid WAV file: "${path}"`);

export const wavOutputBitDepthOf = (bitDepth: SourceBitDepth): WavBitDepth => {
	switch (bitDepth) {
		case "8":
			return "16";
		case "64f":
			return "32f";
		case "16":
		case "24":
		case "32":
		case "32f":
			return bitDepth;
	}
};

const hexPad = (value: number, width: number): string => value.toString(16).padStart(width, "0");

const subFormatGuidOf = (formatData: Buffer): string => {
	if (formatData.length >= SUBFORMAT_GUID_OFFSET + SUBFORMAT_GUID_SIZE) {
		const firstField = formatData.readUInt32LE(SUBFORMAT_GUID_OFFSET);
		const secondField = formatData.readUInt16LE(SUBFORMAT_GUID_OFFSET + 4);
		const thirdField = formatData.readUInt16LE(SUBFORMAT_GUID_OFFSET + 6);
		const remainingBytes = formatData.subarray(SUBFORMAT_GUID_OFFSET + 8, SUBFORMAT_GUID_OFFSET + 16);
		const remainingHex = remainingBytes.toString("hex");

		return `${hexPad(firstField, 8)}-${hexPad(secondField, 4)}-${hexPad(thirdField, 4)}-${remainingHex.slice(0, 4)}-${remainingHex.slice(4)}`;
	}

	return hexPad(formatData.readUInt32LE(SUBFORMAT_GUID_OFFSET), 8);
};

const resolvedAudioFormatOf = (formatData: Buffer, audioFormat: number, bitsPerSample: number): number => {
	if (audioFormat !== WAVE_FORMAT_EXTENSIBLE) {
		return audioFormat;
	}

	const cbSize = formatData.length >= 18 ? formatData.readUInt16LE(16) : 0;

	if (cbSize < WAVE_FORMAT_EXTENSIBLE_EXTENSION_SIZE || formatData.length < SUBFORMAT_GUID_OFFSET + 4) {
		throw new Error("Invalid WAV file: WAVE_FORMAT_EXTENSIBLE fmt chunk is too short to read the SubFormat GUID");
	}

	const subFormatFirstField = formatData.readUInt32LE(SUBFORMAT_GUID_OFFSET);

	if (subFormatFirstField === WAVE_FORMAT_PCM || subFormatFirstField === WAVE_FORMAT_IEEE_FLOAT) {
		return subFormatFirstField;
	}

	throw new Error(
		`Unsupported WAV format: audioFormat ${audioFormat}, SubFormat GUID ${subFormatGuidOf(formatData)}, bitsPerSample ${bitsPerSample}`,
	);
};

const channelMaskOf = (formatData: Buffer, audioFormat: number): number =>
	audioFormat === WAVE_FORMAT_EXTENSIBLE ? formatData.readUInt32LE(CHANNEL_MASK_OFFSET) : 0;

const sourceBitDepthOf = (audioFormat: number, bitsPerSample: number): SourceBitDepth => {
	if (audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
		if (bitsPerSample === 32) {
			return "32f";
		}

		if (bitsPerSample === 64) {
			return "64f";
		}
	}

	if (audioFormat === WAVE_FORMAT_PCM) {
		if (bitsPerSample === 8) {
			return "8";
		}

		if (bitsPerSample === 16) {
			return "16";
		}

		if (bitsPerSample === 24) {
			return "24";
		}

		if (bitsPerSample === 32) {
			return "32";
		}
	}

	throw new Error(`Unsupported WAV format: audioFormat ${audioFormat}, bitsPerSample ${bitsPerSample}`);
};

interface WavFormatFields {
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly channelMask: number;
	readonly bitDepth: SourceBitDepth;
	readonly blockAlign: number;
}

const formatFieldsOf = (formatData: Buffer): WavFormatFields => {
	const audioFormat = formatData.readUInt16LE(0);
	const channelCount = formatData.readUInt16LE(2);
	const sampleRate = formatData.readUInt32LE(4);
	const blockAlign = formatData.readUInt16LE(12);
	const bitsPerSample = formatData.readUInt16LE(14);
	const resolvedAudioFormat = resolvedAudioFormatOf(formatData, audioFormat, bitsPerSample);
	const bitDepth = sourceBitDepthOf(resolvedAudioFormat, bitsPerSample);

	if (channelCount < 1) {
		throw new Error(`Invalid WAV file: channelCount ${channelCount}`);
	}

	if (sampleRate < 1) {
		throw new Error(`Invalid WAV file: sampleRate ${sampleRate}`);
	}

	if (blockAlign < 1) {
		throw new Error(`Invalid WAV file: blockAlign ${blockAlign}`);
	}

	return {
		sampleRate,
		channelCount,
		channelMask: channelMaskOf(formatData, audioFormat),
		bitDepth,
		blockAlign,
	};
};

export interface WavChunkWalk {
	readonly isRf64: boolean;
	ds64DataSize: number | undefined;
	formatFields: WavFormatFields | undefined;
}

export type WavChunkStep =
	| { readonly kind: "skip"; readonly byteCount: number }
	| { readonly kind: "data"; readonly formatFields: WavFormatFields; readonly declaredDataSize: number | undefined };

export const chunkWalkOf = (preamble: Buffer): WavChunkWalk | undefined => {
	const magic = preamble.toString("ascii", 0, 4);
	const wave = preamble.toString("ascii", 8, 12);

	if ((magic !== "RIFF" && magic !== "RF64") || wave !== "WAVE") {
		return undefined;
	}

	return { isRf64: magic === "RF64", ds64DataSize: undefined, formatFields: undefined };
};

const declaredDataSizeOf = (walk: WavChunkWalk, chunkSize: number): number | undefined => {
	if (walk.isRf64 && walk.ds64DataSize !== undefined) {
		return walk.ds64DataSize;
	}

	return chunkSize === STREAMING_DATA_SIZE_SENTINEL ? undefined : chunkSize;
};

export const stepChunk = async (
	walk: WavChunkWalk,
	chunkHeader: Buffer,
	path: string,
	readPayload: (byteCount: number) => Promise<Buffer>,
): Promise<WavChunkStep> => {
	const chunkId = chunkHeader.toString("ascii", 0, 4);
	const chunkSize = chunkHeader.readUInt32LE(4);

	if (chunkId === "ds64") {
		if (chunkSize < DS64_REQUIRED_SIZE) {
			throw invalidWavErrorOf(path);
		}

		const ds64Data = await readPayload(Math.min(chunkSize, 28));

		walk.ds64DataSize = Number(ds64Data.readBigUInt64LE(8));
	} else if (chunkId === "fmt ") {
		if (chunkSize < 16) {
			throw new Error("WAV fmt chunk too small");
		}

		walk.formatFields = formatFieldsOf(await readPayload(Math.min(chunkSize, FORMAT_READ_SIZE_LIMIT)));
	} else if (chunkId === "data") {
		if (walk.formatFields === undefined) {
			throw new Error("WAV file has data chunk before fmt chunk");
		}

		return {
			kind: "data",
			formatFields: walk.formatFields,
			declaredDataSize: declaredDataSizeOf(walk, chunkSize),
		};
	}

	return { kind: "skip", byteCount: chunkSize + (chunkSize % 2) };
};

export const parseWavFormat = async (fileHandle: FileHandle, path: string): Promise<ParsedWavFormat> => {
	const fileSize = (await fileHandle.stat()).size;
	const preamble = Buffer.alloc(12);

	await fileHandle.read(preamble, 0, 12, 0);

	const walk = chunkWalkOf(preamble);

	if (walk === undefined) {
		throw notWavErrorOf(path);
	}

	let offset = 12;
	const chunkHeader = Buffer.alloc(8);

	while (offset + 8 <= fileSize) {
		await fileHandle.read(chunkHeader, 0, 8, offset);

		const payloadOffset = offset + 8;
		const step = await stepChunk(walk, chunkHeader, path, async (byteCount) => {
			const payload = Buffer.alloc(byteCount);
			const { bytesRead } = await fileHandle.read(payload, 0, byteCount, payloadOffset);

			if (bytesRead < byteCount) {
				throw invalidWavErrorOf(path);
			}

			return payload;
		});

		if (step.kind === "data") {
			const availableBytes = fileSize - payloadOffset;

			return {
				...step.formatFields,
				dataOffset: payloadOffset,
				dataSize:
					step.declaredDataSize === undefined ? availableBytes : Math.min(step.declaredDataSize, availableBytes),
			};
		}

		offset = payloadOffset + step.byteCount;
	}

	throw invalidWavErrorOf(path);
};
