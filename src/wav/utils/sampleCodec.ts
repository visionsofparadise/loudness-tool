import type { SourceBitDepth, WavBitDepth } from "./wavFormat";

export const bytesPerSampleOf = (bitDepth: SourceBitDepth): number => {
	switch (bitDepth) {
		case "8":
			return 1;
		case "16":
			return 2;
		case "24":
			return 3;
		case "32":
		case "32f":
			return 4;
		case "64f":
			return 8;
	}
};

export const decodeSample = (buffer: Buffer, offset: number, bitDepth: SourceBitDepth): number => {
	switch (bitDepth) {
		case "8":
			return ((buffer[offset] ?? 128) - 128) / 128;
		case "16":
			return buffer.readInt16LE(offset) / 0x8000;
		case "24": {
			const byte0 = buffer[offset] ?? 0;
			const byte1 = buffer[offset + 1] ?? 0;
			const byte2 = buffer[offset + 2] ?? 0;
			const packed = byte0 | (byte1 << 8) | (byte2 << 16);

			return (packed > 0x7fffff ? packed - 0x1000000 : packed) / 0x800000;
		}
		case "32":
			return buffer.readInt32LE(offset) / 0x80000000;
		case "32f":
			return buffer.readFloatLE(offset);
		case "64f":
			return buffer.readDoubleLE(offset);
	}
};

export const decodeFrames = (
	buffer: Buffer,
	frameCount: number,
	layout: { readonly channelCount: number; readonly blockAlign: number; readonly bitDepth: SourceBitDepth },
): Array<Float64Array> => {
	const { channelCount, blockAlign, bitDepth } = layout;
	const bytesPerSample = bytesPerSampleOf(bitDepth);

	return Array.from({ length: channelCount }, (_, channelIndex) => {
		const channel = new Float64Array(frameCount);
		let sampleOffset = channelIndex * bytesPerSample;

		for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
			channel[frameIndex] = decodeSample(buffer, sampleOffset, bitDepth);
			sampleOffset += blockAlign;
		}

		return channel;
	});
};

const INTEGER_SCALES = {
	"16": { negative: 0x8000, positive: 0x7fff },
	"24": { negative: 0x800000, positive: 0x7fffff },
	"32": { negative: 0x80000000, positive: 0x7fffffff },
} as const;

type IntegerBitDepth = keyof typeof INTEGER_SCALES;

export const integerScalesOf = (bitDepth: WavBitDepth): { negative: number; positive: number } | undefined =>
	bitDepth === "32f" ? undefined : INTEGER_SCALES[bitDepth];

const writeIntegerCode = (buffer: Buffer, offset: number, code: number, bitDepth: IntegerBitDepth): number => {
	switch (bitDepth) {
		case "16":
			buffer.writeInt16LE(code, offset);

			return offset + 2;
		case "24":
			buffer[offset] = code & 0xff;
			buffer[offset + 1] = (code >> 8) & 0xff;
			buffer[offset + 2] = (code >> 16) & 0xff;

			return offset + 3;
		case "32":
			buffer.writeInt32LE(code, offset);

			return offset + 4;
	}
};

export const encodeSample = (buffer: Buffer, offset: number, sample: number, bitDepth: WavBitDepth): number => {
	if (bitDepth === "32f") {
		buffer.writeFloatLE(sample, offset);

		return offset + 4;
	}

	const { negative, positive } = INTEGER_SCALES[bitDepth];
	const clamped = Math.max(-1, Math.min(1, sample));

	return writeIntegerCode(buffer, offset, Math.round(clamped < 0 ? clamped * negative : clamped * positive), bitDepth);
};

export const encodeQuantizedSample = (
	buffer: Buffer,
	offset: number,
	sample: number,
	bitDepth: WavBitDepth,
): number => {
	if (bitDepth === "32f") {
		return encodeSample(buffer, offset, sample, bitDepth);
	}

	const { negative } = INTEGER_SCALES[bitDepth];

	return writeIntegerCode(
		buffer,
		offset,
		Math.max(-negative, Math.min(negative - 1, Math.round(sample * negative))),
		bitDepth,
	);
};
