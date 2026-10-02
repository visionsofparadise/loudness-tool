import { writeFile } from "node:fs/promises";
import { bytesPerSampleOf, encodeSample } from "../wav/utils/sampleCodec";
import type { SourceBitDepth } from "../wav/utils/wavFormat";

export const encodePlanar = (
	channels: ReadonlyArray<Float64Array>,
	bitDepth: SourceBitDepth,
	frameStride?: number,
): Buffer => {
	const frameCount = channels[0]?.length ?? 0;
	const channelCount = channels.length;
	const bytesPerSample = bytesPerSampleOf(bitDepth);
	const stride = frameStride ?? channelCount * bytesPerSample;
	const buffer = Buffer.alloc(frameCount * stride);

	for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
		let offset = frameIndex * stride;

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

const PCM_SUBFORMAT_GUID = Buffer.from([
	0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

const IEEE_FLOAT_SUBFORMAT_GUID = Buffer.from([
	0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

export const writeExtensibleWav = async (
	path: string,
	options: {
		sampleRate: number;
		channelCount: number;
		bitDepth: SourceBitDepth;
		channels: ReadonlyArray<Float64Array>;
		subFormatGuid?: Buffer;
		cbSize?: number;
		channelMask?: number;
	},
): Promise<void> => {
	const data = encodePlanar(options.channels, options.bitDepth);
	const headerSize = 68;
	const file = Buffer.alloc(headerSize + data.length);
	const bytesPerSample = bytesPerSampleOf(options.bitDepth);
	const blockAlign = options.channelCount * bytesPerSample;
	const bitsPerSample = bytesPerSample * 8;
	const isFloat = options.bitDepth === "32f" || options.bitDepth === "64f";
	const subFormatGuid = options.subFormatGuid ?? (isFloat ? IEEE_FLOAT_SUBFORMAT_GUID : PCM_SUBFORMAT_GUID);
	const cbSize = options.cbSize ?? 22;

	file.write("RIFF", 0);
	file.writeUInt32LE(headerSize - 8 + data.length, 4);
	file.write("WAVE", 8);
	file.write("fmt ", 12);
	file.writeUInt32LE(40, 16);
	file.writeUInt16LE(0xfffe, 20);
	file.writeUInt16LE(options.channelCount, 22);
	file.writeUInt32LE(options.sampleRate, 24);
	file.writeUInt32LE(options.sampleRate * blockAlign, 28);
	file.writeUInt16LE(blockAlign, 32);
	file.writeUInt16LE(bitsPerSample, 34);
	file.writeUInt16LE(cbSize, 36);
	file.writeUInt16LE(bitsPerSample, 38);
	file.writeUInt32LE(options.channelMask ?? (1 << options.channelCount) - 1, 40);
	subFormatGuid.copy(file, 44, 0, Math.min(subFormatGuid.length, 16));
	file.write("data", 60);
	file.writeUInt32LE(data.length, 64);
	data.copy(file, headerSize);

	await writeFile(path, file);
};
