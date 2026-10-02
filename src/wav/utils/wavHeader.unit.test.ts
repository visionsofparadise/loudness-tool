import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WavReader } from "../WavReader";
import { wavHeaderOf, type WavHeaderFormat } from "./wavHeader";

const STEREO_16: WavHeaderFormat = {
	sampleRate: 48000,
	channelCount: 2,
	channelMask: 0,
	bitDepth: "16",
	blockAlign: 4,
};
const RIFF_DATA_LIMIT = 0xffffffff - 36;

describe("wavHeaderOf", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-wav-header-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("writes RIFF while the RIFF size fits in 32 bits", () => {
		const header = wavHeaderOf(STEREO_16, RIFF_DATA_LIMIT);

		expect(header).toHaveLength(44);
		expect(header.toString("ascii", 0, 4)).toBe("RIFF");
		expect(header.readUInt32LE(4)).toBe(0xffffffff);
		expect(header.readUInt32LE(40)).toBe(RIFF_DATA_LIMIT);
	});

	it("writes RF64 with a ds64 chunk once the RIFF size passes 0xffffffff", () => {
		const dataSize = RIFF_DATA_LIMIT + 1;
		const header = wavHeaderOf(STEREO_16, dataSize);

		expect(header).toHaveLength(80);
		expect(header.toString("ascii", 0, 4)).toBe("RF64");
		expect(header.readUInt32LE(4)).toBe(0xffffffff);
		expect(header.toString("ascii", 8, 16)).toBe("WAVEds64");
		expect(header.readUInt32LE(16)).toBe(28);
		expect(header.readBigUInt64LE(20)).toBe(BigInt(80 - 8 + dataSize));
		expect(header.readBigUInt64LE(28)).toBe(BigInt(dataSize));
		expect(header.readBigUInt64LE(36)).toBe(BigInt(dataSize / 4));
		expect(header.readUInt32LE(44)).toBe(0);
		expect(header.toString("ascii", 48, 52)).toBe("fmt ");
		expect(header.readUInt32LE(52)).toBe(16);
		expect(header.toString("ascii", 72, 76)).toBe("data");
		expect(header.readUInt32LE(76)).toBe(0xffffffff);
	});

	it("builds an RF64 header the reader parses, clamping the ds64 data size to the bytes present", async () => {
		const path = join(workingDirectory, "rf64.wav");
		const format: WavHeaderFormat = {
			sampleRate: 44100,
			channelCount: 6,
			channelMask: 0x3f,
			bitDepth: "24",
			blockAlign: 18,
		};

		await writeFile(path, Buffer.concat([wavHeaderOf(format, 18 * 300_000_000), Buffer.alloc(18 * 5)]));

		const reader = await WavReader.open(path);

		await reader.close();

		expect(reader.format).toEqual({
			sampleRate: 44100,
			channelCount: 6,
			channelMask: 0x3f,
			bitDepth: "24",
			frameCount: 5,
		});
	});

	it.each([
		["16", 1, 1],
		["24", 6, 1],
		["32f", 6, 3],
	] as const)("writes a %s %i-channel EXTENSIBLE fmt with its SubFormat", (bitDepth, channelCount, subFormat) => {
		const bytesPerSample = bitDepth === "16" ? 2 : bitDepth === "24" ? 3 : 4;
		const channelMask = channelCount === 6 ? 0x3f : 0x4;
		const header = wavHeaderOf(
			{ sampleRate: 48000, channelCount, channelMask, bitDepth, blockAlign: channelCount * bytesPerSample },
			0,
		);

		expect(header).toHaveLength(68);
		expect(header.readUInt32LE(16)).toBe(40);
		expect(header.readUInt16LE(20)).toBe(0xfffe);
		expect(header.readUInt16LE(36)).toBe(22);
		expect(header.readUInt16LE(38)).toBe(bytesPerSample * 8);
		expect(header.readUInt32LE(40)).toBe(channelMask);
		expect(header.subarray(44, 60).toString("hex")).toBe(`0${subFormat}00000000001000800000aa00389b71`);
	});

	it("writes EXTENSIBLE with mask 0 beyond two channels", () => {
		const header = wavHeaderOf({ ...STEREO_16, channelCount: 3, blockAlign: 6 }, 0);

		expect(header.readUInt16LE(20)).toBe(0xfffe);
		expect(header.readUInt32LE(40)).toBe(0);
	});

	it("clamps the byte rate to 0xffffffff when sampleRate × blockAlign passes it", () => {
		const header = wavHeaderOf({ ...STEREO_16, sampleRate: 384000, blockAlign: 65535 }, 0);

		expect(header.readUInt32LE(24)).toBe(384000);
		expect(header.readUInt32LE(28)).toBe(0xffffffff);
		expect(header.readUInt16LE(32)).toBe(65535);
	});
});
