import { describe, expect, it } from "vitest";
import { bytesPerSampleOf, decodeSample, encodeSample, quantizerOf } from "./sampleCodec";
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

	it("writes 16-bit negative full-scale as -0x8000", () => {
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

		expect(packed).toBe(0x400000);
		expect(next).toBe(3);
	});

	it("writes 32-bit integer PCM", () => {
		const buffer = Buffer.alloc(4);
		const next = encodeSample(buffer, 0, 0.5, "32");

		expect(buffer.readInt32LE(0)).toBe(0x40000000);
		expect(next).toBe(4);
	});

	it("writes 8-bit unsigned on the 0x80 scale and clamps beyond full scale", () => {
		const buffer = Buffer.alloc(6);

		[-1, 0, 0.5, 1, 2, -2].forEach((sample, index) => encodeSample(buffer, index, sample, "8"));

		expect([...buffer]).toEqual([0x00, 0x80, 0xc0, 0xff, 0xff, 0x00]);
		expect(encodeSample(buffer, 2, 0, "8")).toBe(3);
	});

	it("round-trips 64-bit float bit for bit", () => {
		const buffer = Buffer.alloc(8);

		for (const sample of [0.1, -0.30000000000000004, 1e-300, 1.5, -2.5e10, Math.PI]) {
			expect(encodeSample(buffer, 0, sample, "64f")).toBe(8);
			expect(decodeSample(buffer, 0, "64f")).toBe(sample);
		}
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

describe("encodeSample of a decoded code", () => {
	const codeOf = (buffer: Buffer, bitDepth: "16" | "24"): number =>
		bitDepth === "16" ? buffer.readInt16LE(0) : buffer.readIntLE(0, 3);

	it.each([
		["16", 0x8000],
		["24", 0x800000],
	] as const)("writes every %s-bit code it decodes back as that code", (bitDepth, full) => {
		const buffer = Buffer.alloc(3);

		for (let code = -full; code < full; code++) {
			buffer.writeIntLE(code, 0, bitDepth === "16" ? 2 : 3);
			encodeSample(buffer, 0, decodeSample(buffer, 0, bitDepth), bitDepth);

			if (codeOf(buffer, bitDepth) !== code) {
				expect(codeOf(buffer, bitDepth)).toBe(code);
			}
		}
	});

	it("writes a positive and a negative sample of one magnitude as codes of one magnitude", () => {
		const buffer = Buffer.alloc(2);

		for (const magnitude of [0.25, 0.5, 0.75, 0.9999]) {
			encodeSample(buffer, 0, magnitude, "16");

			const positive = buffer.readInt16LE(0);

			encodeSample(buffer, 0, -magnitude, "16");

			expect(buffer.readInt16LE(0)).toBe(-positive);
		}
	});
});

describe("integer rounding in encodeSample and quantizerOf", () => {
	const SCALES = { "8": 0x80, "16": 0x8000, "24": 0x800000, "32": 0x80000000 } as const;
	const readCodeOf = (buffer: Buffer, bitDepth: keyof typeof SCALES): number => {
		switch (bitDepth) {
			case "8":
				return (buffer[0] ?? 0) - 0x80;
			case "16":
				return buffer.readInt16LE(0);
			case "24":
				return buffer.readIntLE(0, 3);
			case "32":
				return buffer.readInt32LE(0);
		}
	};
	const CASES: ReadonlyArray<readonly [number, number]> = [
		[0.5, 0],
		[-0.5, 0],
		[1.5, 2],
		[-1.5, -2],
		[2.5, 2],
		[-2.5, -2],
		[3.5, 4],
		[-3.5, -4],
		[0.49, 0],
		[0.51, 1],
		[-0.51, -1],
		[1.25, 1],
		[-1.75, -2],
		[0, 0],
	];

	it.each(["8", "16", "24", "32"] as const)("rounds %s-bit ties to the even code and clamps", (bitDepth) => {
		const scale = SCALES[bitDepth];
		const quantize = quantizerOf(bitDepth);
		const buffer = Buffer.alloc(4);
		const cases: ReadonlyArray<readonly [number, number]> = [
			...CASES,
			[scale / 2 + 0.5, scale / 2],
			[-scale / 2 - 1.5, -scale / 2 - 2],
			[scale - 0.5, scale - 1],
			[-scale - 0.5, -scale],
			[2 * scale, scale - 1],
			[-2 * scale, -scale],
		];

		for (const [lsb, code] of cases) {
			const sample = lsb / scale;

			encodeSample(buffer, 0, sample, bitDepth);

			expect([lsb, readCodeOf(buffer, bitDepth)]).toEqual([lsb, code]);
			expect([lsb, quantize(sample) + 0]).toEqual([lsb, code / scale]);
		}
	});

	it("passes 64f through and rounds 32f to the nearest single", () => {
		const identity = quantizerOf("64f");
		const single = quantizerOf("32f");

		for (const sample of [0.1, -0.30000000000000004, 1e-300, 1.5, -2.5e10]) {
			expect(identity(sample)).toBe(sample);
		}

		expect(single(0.1)).toBe(0.100000001490116119384765625);
		expect(single(-1 / 3)).toBe(-0.3333333432674407958984375);
		expect(single(0.5)).toBe(0.5);
	});
});
