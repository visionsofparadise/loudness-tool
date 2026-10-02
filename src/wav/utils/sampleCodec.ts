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

export const encodeSample = (buffer: Buffer, offset: number, sample: number, bitDepth: WavBitDepth): number => {
	switch (bitDepth) {
		case "16": {
			const clamped = Math.max(-1, Math.min(1, sample));
			const quantized = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

			buffer.writeInt16LE(Math.round(quantized), offset);

			return offset + 2;
		}
		case "24": {
			const clamped = Math.max(-1, Math.min(1, sample));
			const quantized = Math.round(clamped < 0 ? clamped * 0x800000 : clamped * 0x7fffff);

			buffer[offset] = quantized & 0xff;
			buffer[offset + 1] = (quantized >> 8) & 0xff;
			buffer[offset + 2] = (quantized >> 16) & 0xff;

			return offset + 3;
		}
		case "32": {
			const clamped = Math.max(-1, Math.min(1, sample));
			const quantized = clamped < 0 ? clamped * 0x80000000 : clamped * 0x7fffffff;

			buffer.writeInt32LE(Math.round(quantized), offset);

			return offset + 4;
		}
		case "32f": {
			buffer.writeFloatLE(sample, offset);

			return offset + 4;
		}
	}
};
