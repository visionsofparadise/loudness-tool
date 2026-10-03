import { describe, expect, it } from "vitest";
import { channelLayoutOf } from "./channelLayout";
import { resolveOutput } from "./sinks";
import { DEFAULT_STREAM_OPTIONS, type StreamOptions } from "./streamOptions";
import type { StreamFormat } from "../../wav/WavReader";

const FIVE_ONE: StreamFormat = { sampleRate: 48000, channelCount: 6, channelMask: 0x3f, bitDepth: "24" };

const resolve = (stream: Partial<StreamOptions>, format: StreamFormat = FIVE_ONE): ReturnType<typeof resolveOutput> =>
	resolveOutput({ path: "out.raw", stream: { ...DEFAULT_STREAM_OPTIONS, ...stream } }, format);

const layout = (value: string): StreamOptions["channelLayout"] => channelLayoutOf(value);

describe("resolveOutput", () => {
	it("writes WAV at the WAV output depth and raw at the depth -f names, to a file or a descriptor", () => {
		expect(resolve({}).output).toEqual({
			sink: { kind: "file", path: "out.raw" },
			container: "wav",
			bitDepth: "24",
			channelMask: 0x3f,
		});
		expect(resolve({}, { ...FIVE_ONE, bitDepth: "8" }).output.bitDepth).toBe("16");
		expect(resolve({}, { ...FIVE_ONE, bitDepth: "64f" }).output.bitDepth).toBe("32f");
		expect(resolve({ format: "u8" }).output).toMatchObject({ container: "raw", bitDepth: "8" });
		expect(resolve({ format: "f64le" }).output).toMatchObject({ container: "raw", bitDepth: "64f" });
		expect(resolveOutput({ path: "pipe:1", stream: DEFAULT_STREAM_OPTIONS }, FIVE_ONE).output.sink).toEqual({
			kind: "stream",
			stream: process.stdout,
		});
	});

	it("keeps the input's rate under -ar 0 or its own rate and refuses any other", () => {
		expect(resolve({ sampleRate: 0 }).format).toEqual(FIVE_ONE);
		expect(resolve({ sampleRate: 48000 }).format).toEqual(FIVE_ONE);
		expect(() => resolve({ sampleRate: -1 })).toThrow("Invalid sample rate: -1");
		expect(() => resolve({ sampleRate: 44100 })).toThrow(
			"loudness-tool keeps the input's sample rate: output -ar 44100 differs from the input's 48000",
		);
	});

	it("takes -ch_layout over -ac, keeps a stated layout under a count form or an equal layout, and refuses a remix", () => {
		expect(resolve({ channelCount: 2, channelLayout: layout("5.1") }).format.channelMask).toBe(0x3f);
		expect(resolve({ channelLayout: layout("6C") }).format.channelMask).toBe(0x3f);
		expect(resolve({ channelLayout: layout("6 channels") }).format.channelMask).toBe(0x3f);
		expect(() => resolve({ channelLayout: layout("5.1(side)") })).toThrow(
			"loudness-tool keeps the input's channels: output -ch_layout 5.1(side) differs from the input's layout 0x3f",
		);
		expect(() => resolve({ channelLayout: layout("stereo") })).toThrow(
			"loudness-tool keeps the input's channels: output -ch_layout stereo has 2 channels, the input 6",
		);
	});

	it("reads an output count form as -ac reads its count: kept over no layout and over the count's default layout, a remix over any other", () => {
		const count = (channelCount: number, channelMask: number): StreamFormat => ({
			...FIVE_ONE,
			channelCount,
			channelMask,
		});

		expect(resolve({ channelLayout: layout("6C") }, count(6, 0)).format.channelMask).toBe(0);
		expect(resolve({ channelLayout: layout("6 channels") }, count(6, 0)).format.channelMask).toBe(0);
		expect(resolve({ channelLayout: layout("3C") }, count(3, 0xb)).format.channelMask).toBe(0xb);
		expect(() => resolve({ channelLayout: layout("6C") }, count(6, 0x60f))).toThrow(
			"loudness-tool keeps the input's channels: output -ch_layout 6C would rematrix the input's layout 0x60f to 6's default layout",
		);
		expect(() => resolve({ channelLayout: layout("3 channels") }, count(3, 0x7))).toThrow(
			"output -ch_layout 3 channels would rematrix the input's layout 0x7 to 3's default layout",
		);
		expect(() => resolve({ channelLayout: layout("16C") }, count(16, 0xffff))).toThrow("would rematrix");
	});

	it("keeps a stated layout under a count with no ffmpeg default layout, as ffmpeg does", () => {
		expect(
			resolve({ channelCount: 9 }, { ...FIVE_ONE, channelCount: 9, channelMask: 0x1ff }).format.channelMask,
		).toBe(0x1ff);
		expect(
			resolve({ channelLayout: layout("9C") }, { ...FIVE_ONE, channelCount: 9, channelMask: 0x1ff }).format
				.channelMask,
		).toBe(0x1ff);
		expect(
			resolve({ channelCount: 11 }, { ...FIVE_ONE, channelCount: 11, channelMask: 0x7ff }).format.channelMask,
		).toBe(0x7ff);
	});

	it("relabels an input with no stated layout through an output -ch_layout of its count", () => {
		const unstated = { ...FIVE_ONE, channelMask: 0 };
		const relabelled = resolve({ channelLayout: layout("5.1") }, unstated);

		expect(relabelled.format.channelMask).toBe(0x3f);
		expect(relabelled.output.channelMask).toBe(0x3f);
		expect(resolve({ channelLayout: layout("6.0") }, unstated).format.channelMask).toBe(0x707);
	});

	it.each([
		[1, 0x4],
		[2, 0x3],
		[3, 0xb],
		[4, 0x107],
		[5, 0x37],
		[6, 0x3f],
		[7, 0x70f],
		[8, 0x63f],
		[10, 0x2d60f],
		[12, 0x2d63f],
		[14, 0x2d6ff],
	])("accepts -ac %i over no layout and over its default layout %i", (count, mask) => {
		const format = { ...FIVE_ONE, channelCount: count };

		expect(resolve({ channelCount: count }, { ...format, channelMask: 0 }).format.channelMask).toBe(0);
		expect(resolve({ channelCount: count }, { ...format, channelMask: mask }).format.channelMask).toBe(mask);
	});

	it("refuses -ac over another stated layout, another count or a negative count, and keeps the count under -ac 0", () => {
		expect(resolve({ channelCount: 0 }).format).toEqual(FIVE_ONE);
		expect(() => resolve({ channelCount: 6 }, { ...FIVE_ONE, channelMask: 0x60f })).toThrow(
			"loudness-tool keeps the input's channels: output -ac 6 would rematrix the input's layout 0x60f to 6's default layout",
		);
		expect(() => resolve({ channelCount: 16 }, { ...FIVE_ONE, channelCount: 16, channelMask: 0xffff })).toThrow(
			"would rematrix",
		);
		expect(() => resolve({ channelCount: 2 })).toThrow(
			"loudness-tool keeps the input's channels: output -ac 2 differs from the input's 6",
		);
		expect(() => resolve({ channelCount: -1 })).toThrow("Invalid channel count: -1");
	});
});
