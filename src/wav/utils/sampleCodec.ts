import type { SourceBitDepth } from "./wavFormat";

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

const INTEGER_FULL_SCALES = {
	"8": 0x80,
	"16": 0x8000,
	"24": 0x800000,
	"32": 0x80000000,
} as const;

type IntegerBitDepth = keyof typeof INTEGER_FULL_SCALES;

const roundHalfToEven = (value: number): number => {
	const rounded = Math.round(value);

	return rounded - value === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
};

const codeOf = (sample: number, fullScale: number): number =>
	Math.max(-fullScale, Math.min(fullScale - 1, roundHalfToEven(sample * fullScale)));

const writeIntegerCode = (buffer: Buffer, offset: number, code: number, bitDepth: IntegerBitDepth): number => {
	switch (bitDepth) {
		case "8":
			buffer[offset] = code + 0x80;

			return offset + 1;
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

export const encodeSample = (buffer: Buffer, offset: number, sample: number, bitDepth: SourceBitDepth): number => {
	if (bitDepth === "32f") {
		buffer.writeFloatLE(sample, offset);

		return offset + 4;
	}

	if (bitDepth === "64f") {
		buffer.writeDoubleLE(sample, offset);

		return offset + 8;
	}

	return writeIntegerCode(buffer, offset, codeOf(sample, INTEGER_FULL_SCALES[bitDepth]), bitDepth);
};

export const quantizerOf = (bitDepth: SourceBitDepth): ((sample: number) => number) => {
	if (bitDepth === "64f") {
		return (sample) => sample;
	}

	if (bitDepth === "32f") {
		return (sample) => Math.fround(sample);
	}

	const fullScale = INTEGER_FULL_SCALES[bitDepth];

	return (sample) => codeOf(sample, fullScale) / fullScale;
};
