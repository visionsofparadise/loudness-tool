import type { FileHandle } from "node:fs/promises";

export type WavBitDepth = "16" | "24" | "32" | "32f";

export type SourceBitDepth = WavBitDepth | "8" | "64f";

export interface ParsedWavFormat {
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly bitDepth: SourceBitDepth;
	readonly blockAlign: number;
	readonly dataOffset: number;
	readonly dataSize: number;
}

const RIFF_HEADER_OVERHEAD = 36;
const RIFF_DATA_SIZE_LIMIT = 0xffffffff - RIFF_HEADER_OVERHEAD;
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const WAVE_FORMAT_EXTENSIBLE_EXTENSION_SIZE = 22;
const SUBFORMAT_GUID_OFFSET = 24;
const SUBFORMAT_GUID_SIZE = 16;
const FORMAT_READ_SIZE_LIMIT = 64;
const STREAMING_DATA_SIZE_SENTINEL = 0xffffffff;

export const nearestWritableBitDepth = (bitDepth: SourceBitDepth): WavBitDepth => {
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

export const assertRiffDataSize = (dataSize: number): void => {
	const paddedPayloadSize = dataSize + (dataSize % 2);

	if (paddedPayloadSize > RIFF_DATA_SIZE_LIMIT) {
		throw new Error(
			`RIFF data size ${dataSize} exceeds the ${RIFF_DATA_SIZE_LIMIT} byte payload ceiling (0xffffffff minus the 36-byte header)`,
		);
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

export const parseWavFormat = async (fileHandle: FileHandle, path: string): Promise<ParsedWavFormat> => {
	const fileInfo = await fileHandle.stat();
	const header = Buffer.alloc(12);

	await fileHandle.read(header, 0, 12, 0);

	const magic = header.toString("ascii", 0, 4);
	const wave = header.toString("ascii", 8, 12);

	if ((magic !== "RIFF" && magic !== "RF64") || wave !== "WAVE") {
		throw new Error(`Not a WAV file: "${path}"`);
	}

	const isRf64 = magic === "RF64";
	let ds64DataSize: number | undefined;
	let offset = 12;
	const fileSize = fileInfo.size;
	let formatFields:
		| {
				readonly sampleRate: number;
				readonly channelCount: number;
				readonly bitDepth: SourceBitDepth;
				readonly blockAlign: number;
		  }
		| undefined;
	const chunkHeader = Buffer.alloc(8);

	while (offset + 8 <= fileSize) {
		await fileHandle.read(chunkHeader, 0, 8, offset);

		const chunkId = chunkHeader.toString("ascii", 0, 4);
		const chunkSize = chunkHeader.readUInt32LE(4);

		if (chunkId === "ds64") {
			const ds64Data = Buffer.alloc(Math.min(chunkSize, 28));

			await fileHandle.read(ds64Data, 0, ds64Data.length, offset + 8);

			ds64DataSize = Number(ds64Data.readBigUInt64LE(8));
		} else if (chunkId === "fmt ") {
			if (chunkSize < 16) {
				throw new Error("WAV fmt chunk too small");
			}

			const formatReadSize = Math.min(chunkSize, FORMAT_READ_SIZE_LIMIT);
			const formatData = Buffer.alloc(formatReadSize);

			await fileHandle.read(formatData, 0, formatReadSize, offset + 8);

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

			formatFields = {
				sampleRate,
				channelCount,
				bitDepth,
				blockAlign,
			};
		} else if (chunkId === "data") {
			if (formatFields === undefined) {
				throw new Error("WAV file has data chunk before fmt chunk");
			}

			const dataOffset = offset + 8;
			const availableBytes = fileSize - dataOffset;
			const declaredSize = isRf64 && ds64DataSize !== undefined ? ds64DataSize : chunkSize;
			const isStreamingSentinel =
				!(isRf64 && ds64DataSize !== undefined) && declaredSize === STREAMING_DATA_SIZE_SENTINEL;
			const dataSize = isStreamingSentinel ? availableBytes : Math.min(declaredSize, availableBytes);

			return {
				...formatFields,
				dataOffset,
				dataSize,
			};
		}

		offset += 8 + chunkSize;

		if (chunkSize % 2 !== 0) {
			offset++;
		}
	}

	throw new Error(`Invalid WAV file: "${path}"`);
};
