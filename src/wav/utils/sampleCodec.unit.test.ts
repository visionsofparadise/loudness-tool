import { describe, expect, it } from "vitest";
import { bytesPerSampleOf, decodeSample, encodeSample } from "./sampleCodec";
import { type WavBitDepth } from "./wavFormat";

const roundTrip = (sample: number, bitDepth: WavBitDepth): number => {
	const buffer = Buffer.alloc(bytesPerSampleOf(bitDepth));

	encodeSample(buffer, 0, sample, bitDepth);

	return decodeSample(buffer, 0, bitDepth);
};

describe("bytesPerSampleOf", () => {
	it("maps each source bit depth to its byte width", () => {
		expect(bytesPerSampleOf("8")).toBe(1);
		expect(bytesPerSampleOf("16")).toBe(2);
		expect(bytesPerSampleOf("24")).toBe(3);
		expect(bytesPerSampleOf("32")).toBe(4);
		expect(bytesPerSampleOf("32f")).toBe(4);
		expect(bytesPerSampleOf("64f")).toBe(8);
	});
});

describe("decodeSample", () => {
	it("decodes 8-bit unsigned PCM (128 = silence)", () => {
		const buffer = Buffer.from([192]);

		expect(decodeSample(buffer, 0, "8")).toBeCloseTo(0.5, 6);
	});

	it("decodes 16-bit signed PCM to [-1, 1)", () => {
		const buffer = Buffer.alloc(2);

		buffer.writeInt16LE(16384, 0);

		expect(decodeSample(buffer, 0, "16")).toBeCloseTo(0.5, 6);
	});

	it("decodes 16-bit full-scale negative to exactly -1", () => {
		const buffer = Buffer.alloc(2);

		buffer.writeInt16LE(-32768, 0);

		expect(decodeSample(buffer, 0, "16")).toBe(-1);
	});

	it("decodes 24-bit signed PCM", () => {
		const positive = Buffer.from([0x00, 0x00, 0x40]);
		const negative = Buffer.from([0x00, 0x00, 0x80]);

		expect(decodeSample(positive, 0, "24")).toBeCloseTo(0.5, 6);
		expect(decodeSample(negative, 0, "24")).toBe(-1);
	});

	it("decodes 32-bit signed PCM", () => {
		const buffer = Buffer.alloc(4);

		buffer.writeInt32LE(0x40000000, 0);

		expect(decodeSample(buffer, 0, "32")).toBeCloseTo(0.5, 6);
	});

	it("decodes 32-bit IEEE float", () => {
		const buffer = Buffer.alloc(4);

		buffer.writeFloatLE(0.25, 0);

		expect(decodeSample(buffer, 0, "32f")).toBe(0.25);
	});

	it("decodes 64-bit IEEE float", () => {
		const buffer = Buffer.alloc(8);

		buffer.writeDoubleLE(0.75, 0);

		expect(decodeSample(buffer, 0, "64f")).toBe(0.75);
	});

	it("honours the byte offset", () => {
		const buffer = Buffer.alloc(4);

		buffer.writeInt16LE(0, 0);
		buffer.writeInt16LE(-32768, 2);

		expect(decodeSample(buffer, 2, "16")).toBe(-1);
	});
});

describe("encodeSample", () => {
	it("writes 16-bit full-scale and returns the advanced offset", () => {
		const buffer = Buffer.alloc(2);
		const next = encodeSample(buffer, 0, 1, "16");

		expect(buffer.readInt16LE(0)).toBe(32767);
		expect(next).toBe(2);
	});

	it("writes 16-bit negative full-scale using the 0x8000 factor", () => {
		const buffer = Buffer.alloc(2);

		encodeSample(buffer, 0, -1, "16");

		expect(buffer.readInt16LE(0)).toBe(-32768);
	});

	it("clamps out-of-range samples to [-1, 1] for integer depths", () => {
		const buffer = Buffer.alloc(4);

		encodeSample(buffer, 0, 2, "16");
		encodeSample(buffer, 2, -2, "16");

		expect(buffer.readInt16LE(0)).toBe(32767);
		expect(buffer.readInt16LE(2)).toBe(-32768);
	});

	it("writes 24-bit little-endian and advances by 3", () => {
		const buffer = Buffer.alloc(3);
		const next = encodeSample(buffer, 0, 0.5, "24");
		const packed = (buffer[0] ?? 0) | ((buffer[1] ?? 0) << 8) | ((buffer[2] ?? 0) << 16);

		expect(packed).toBe(Math.round(0.5 * 0x7fffff));
		expect(next).toBe(3);
	});

	it("writes 32-bit integer PCM", () => {
		const buffer = Buffer.alloc(4);
		const next = encodeSample(buffer, 0, 0.5, "32");

		expect(buffer.readInt32LE(0)).toBe(Math.round(0.5 * 0x7fffffff));
		expect(next).toBe(4);
	});

	it("writes 32-bit float verbatim", () => {
		const buffer = Buffer.alloc(4);
		const next = encodeSample(buffer, 0, 0.123, "32f");

		expect(buffer.readFloatLE(0)).toBe(Math.fround(0.123));
		expect(next).toBe(4);
	});
});

describe("encodeSample/decodeSample round trip", () => {
	it("is bit-exact for 32f", () => {
		expect(roundTrip(0.123, "32f")).toBe(Math.fround(0.123));
		expect(roundTrip(-1, "32f")).toBe(-1);
	});

	it("stays within one quantization step for integer depths", () => {
		const samples = [-1, -0.5, 0, 0.25, 1];

		for (const sample of samples) {
			expect(Math.abs(roundTrip(sample, "16") - sample)).toBeLessThanOrEqual(1.5 / 0x8000);
			expect(Math.abs(roundTrip(sample, "24") - sample)).toBeLessThanOrEqual(1.5 / 0x800000);
			expect(Math.abs(roundTrip(sample, "32") - sample)).toBeLessThanOrEqual(1.5 / 0x80000000);
		}
	});
});
