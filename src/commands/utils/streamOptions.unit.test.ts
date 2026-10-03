import { describe, expect, it } from "vitest";
import { createProgram } from "../../cli";
import { DEFAULT_STREAM_OPTIONS, inputFormatOf, scopeStreamArguments, type StreamOptions } from "./streamOptions";
import type { StreamFormat } from "../../wav/WavReader";

const scope = (args: ReadonlyArray<string>): ReturnType<typeof scopeStreamArguments> =>
	scopeStreamArguments(args, createProgram());

const streamOf = (options: Partial<StreamOptions>): StreamOptions => ({ ...DEFAULT_STREAM_OPTIONS, ...options });

const layout = (name: string, channelCount: number, channelMask: number): StreamOptions["channelLayout"] => ({
	name,
	channelCount,
	channelMask,
});

describe("scopeStreamArguments", () => {
	it("scopes BAG's raw input and output options and leaves Commander the rest", () => {
		const scoped = scope("lufs-norm -f f32le -ar 48000 -ac 2 - -f f32le -ar 48000 -ac 2 -o -".split(" "));
		const raw = streamOf({ format: "f32le", sampleRate: 48000, channelCount: 2 });

		expect(scoped.args).toEqual(["lufs-norm", "-", "-o", "-"]);
		expect(scoped.command?.name()).toBe("lufs-norm");
		expect(scoped.scopes).toEqual({ inputs: [{ ...raw, sampleRateOption: "-ar" }], output: raw });
		expect(scoped.warnings).toEqual([]);
	});

	it.each([[["-o", "out.raw"]], [["-oout.raw"]], [["--output", "out.raw"]], [["--output=out.raw"]]])(
		"gives the pending options to the output written as %j",
		(outputTokens) => {
			const scoped = scope(["lufs-norm", "-f", "s16le", ...outputTokens, "-f", "f32le", "in.raw"]);

			expect(scoped.args).toEqual(["lufs-norm", ...outputTokens, "in.raw"]);
			expect(scoped.scopes).toEqual({
				inputs: [streamOf({ format: "f32le" })],
				output: streamOf({ format: "s16le" }),
			});
		},
	);

	it("steps over command and program option values wherever they sit", () => {
		const scoped = scope(["--scratch-dir", "a", "target", "-f", "s16le", "-", "--scratch-dir", "b", "-o", "-"]);
		const after = scope([
			"target",
			"-f",
			"s16le",
			"-",
			"-o",
			"-",
			"--lufs",
			"-16",
			"--tp",
			"-1",
			"--scratch-dir",
			"c",
		]);

		expect(scoped.args).toEqual(["--scratch-dir", "a", "target", "-", "--scratch-dir", "b", "-o", "-"]);
		expect(scoped.scopes).toEqual({ inputs: [streamOf({ format: "s16le" })], output: DEFAULT_STREAM_OPTIONS });
		expect(after.args).toEqual(["target", "-", "-o", "-", "--lufs", "-16", "--tp", "-1", "--scratch-dir", "c"]);
		expect(after.scopes).toEqual({ inputs: [streamOf({ format: "s16le" })], output: DEFAULT_STREAM_OPTIONS });
	});

	it("gives each stats input the options in front of it", () => {
		const scoped = scope("stats -f f32le -ac 2 - b.wav -f s16le c.raw --json".split(" "));

		expect(scoped.args).toEqual(["stats", "-", "b.wav", "c.raw", "--json"]);
		expect(scoped.scopes.inputs).toEqual([
			streamOf({ format: "f32le", channelCount: 2 }),
			DEFAULT_STREAM_OPTIONS,
			streamOf({ format: "s16le" }),
		]);
	});

	it("reads every token after -- as an operand and keeps -- for Commander", () => {
		expect(scope("stats -f s16le -- -x".split(" "))).toMatchObject({
			args: ["stats", "--", "-x"],
			scopes: { inputs: [streamOf({ format: "s16le" })] },
		});
		expect(scope("stats -f s16le -- a.raw".split(" ")).args).toEqual(["stats", "--", "a.raw"]);
	});

	it("reads a negative number as an operand unless an option takes it", () => {
		expect(scope("stats -f s16le -5".split(" ")).scopes.inputs).toEqual([streamOf({ format: "s16le" })]);
		expect(scope("target - -o - --lufs -16".split(" ")).scopes.inputs).toEqual([DEFAULT_STREAM_OPTIONS]);
	});

	it("keeps the last of repeated options and warns where ffmpeg warns", () => {
		const input = (options: string): ReturnType<typeof scope> => scope(["stats", ...options.split(" "), "in.raw"]);

		expect(input("-ar 44100 -ar 48000")).toMatchObject({
			scopes: { inputs: [streamOf({ sampleRate: 48000, sampleRateOption: "-ar" })] },
			warnings: [],
		});
		expect(input("-ch_layout mono -channel_layout stereo")).toMatchObject({
			scopes: { inputs: [streamOf({ channelLayout: layout("stereo", 2, 3) })] },
			warnings: ['-channel_layout is given more than once for the input "in.raw"; the last value, stereo, is used'],
		});
		expect(input("-ch_layout:v mono -ch_layout stereo")).toMatchObject({
			scopes: { inputs: [streamOf({ channelLayout: layout("stereo", 2, 3) })] },
			warnings: [],
		});
		expect(scope("lufs-norm - -ar 44100 -ar 22050 -ac 1 -ac 2 -f u8 -f s16le -o -".split(" "))).toMatchObject({
			scopes: { output: streamOf({ format: "s16le", sampleRate: 22050, channelCount: 2 }) },
			warnings: [
				"-ar is given more than once for the output; the last value, 22050, is used",
				"-ac is given more than once for the output; the last value, 2, is used",
			],
		});
	});

	it.each(["-ar:a", "-ar:0", "-ar:#0x0", "-ar:v", "-ar:1", "-sample_rate"])(
		"sets an input's rate through %s",
		(option) => {
			expect(scope(["stats", option, "48000", "in.raw"])).toMatchObject({
				scopes: { inputs: [streamOf({ sampleRate: 48000, sampleRateOption: option })] },
				warnings: [],
			});
		},
	);

	it("takes an input's last -ar and -ac whatever their specifiers, and -ar over -sample_rate in either order", () => {
		const input = (options: string): StreamOptions | undefined =>
			scope(["stats", "-f", "s16le", ...options.split(" "), "in.raw"]).scopes.inputs[0];

		expect(input("-ar:a 48000 -ar:v 22050")?.sampleRate).toBe(22050);
		expect(input("-ac:a 2 -ac:v 1")?.channelCount).toBe(1);
		expect(input("-ar 22050 -sample_rate 48000")?.sampleRate).toBe(22050);
		expect(input("-sample_rate 48000 -ar 22050")?.sampleRate).toBe(22050);
		expect(input("-sample_rate garbage -ar 48000")?.sampleRate).toBe(48000);
		expect(input("-sample_rate garbage -sample_rate 48000")?.sampleRate).toBe(48000);
	});

	it.each([
		["-ch_layout:a FL+FR -ch_layout:v SL+SR", 2, 0x3],
		["-ch_layout:a 6C -ch_layout:v 5.1", 6, 0],
		["-ch_layout:a 5.1(side) -ch_layout:v 5.1", 6, 0x60f],
		["-ch_layout:v 5.1", 6, 0x3f],
		["-ch_layout:v 6C", 6, 0],
		["-ac:a 3 -ch_layout:v stereo", 2, 0x3],
		["-ch_layout garbage -ch_layout stereo", 2, 0x3],
		["-ch_layout:v garbage -ch_layout:a stereo", 2, 0x3],
		["-channel_layout mono -ch_layout stereo", 2, 0x3],
	])(
		"reads a raw input under %s as %i channels with mask %i, its demuxer taking the last -ch_layout and its stream the last that selects it",
		(options, channelCount, channelMask) => {
			const stream = scope(["stats", "-f", "s16le", ...options.split(" "), "in.raw"]).scopes.inputs[0];

			expect(inputFormatOf(stream ?? DEFAULT_STREAM_OPTIONS, "in.raw", undefined)).toMatchObject({
				channelCount,
				channelMask,
			});
		},
	);

	it("fails a raw input whose stream's -ch_layout has another count than its demuxer's, or whose applied layout is malformed", () => {
		const formatOf = (options: string): StreamFormat => {
			const stream = scope(["stats", "-f", "s16le", ...options.split(" "), "in.raw"]).scopes.inputs[0];

			return inputFormatOf(stream ?? DEFAULT_STREAM_OPTIONS, "in.raw", undefined);
		};

		expect(() => formatOf("-ch_layout:a stereo -ch_layout:v mono")).toThrow(
			'Channel layout "stereo" has 2 channels, and "in.raw" has 1',
		);
		expect(() => formatOf("-ch_layout:u stereo -ch_layout:v mono")).toThrow('Channel layout "stereo" has 2 channels');
		expect(() => formatOf("-ch_layout:a garbage -ch_layout:v stereo")).toThrow(
			'Unsupported channel layout "garbage"',
		);
		expect(() => formatOf("-ch_layout:a stereo -ch_layout:v garbage")).toThrow(
			'Unsupported channel layout "garbage"',
		);
	});

	it("applies to a WAV input only a -ch_layout whose specifier selects its stream", () => {
		const header: StreamFormat = { sampleRate: 48000, channelCount: 2, channelMask: 0x3, bitDepth: "16" };
		const maskOf = (options: string): number => {
			const stream = scope(["stats", ...options.split(" "), "in.wav"]).scopes.inputs[0];

			return inputFormatOf(stream ?? DEFAULT_STREAM_OPTIONS, "in.wav", header).channelMask;
		};

		expect(maskOf("-ch_layout:v SL+SR")).toBe(0x3);
		expect(maskOf("-ch_layout:v 5.1")).toBe(0x3);
		expect(maskOf("-ch_layout:v garbage")).toBe(0x3);
		expect(maskOf("-ch_layout:u SL+SR")).toBe(0x600);
		expect(maskOf("-ch_layout:disp:0 SL+SR")).toBe(0x600);
		expect(maskOf("-ch_layout:v 5.1 -ch_layout:a SL+SR")).toBe(0x600);
		expect(maskOf("-ch_layout garbage -ch_layout SL+SR")).toBe(0x600);
	});

	it("warns of an input -ch_layout repeated on its stream, u included", () => {
		expect(scope("stats -ch_layout:u mono -ch_layout stereo in.raw".split(" ")).warnings).toEqual([
			'-ch_layout is given more than once for the input "in.raw"; the last value, stereo, is used',
		]);
	});

	it("reads -f with any specifier as -f, and only the last -f's value", () => {
		expect(scope("lufs-norm -f:foo s16le - -f:x:y:z u8 -o -".split(" "))).toMatchObject({
			scopes: { inputs: [streamOf({ format: "s16le" })], output: streamOf({ format: "u8" }) },
			warnings: [],
		});
		expect(scope("stats -f garbage -f s16le in.raw".split(" ")).scopes.inputs).toEqual([
			streamOf({ format: "s16le" }),
		]);
	});

	it("reads only the output -ch_layout it applies, and ignores -sample_rate whatever its value", () => {
		expect(scope(["lufs-norm", "-", "-ch_layout:v", "garbage", "-o", "-"])).toMatchObject({
			scopes: { output: DEFAULT_STREAM_OPTIONS },
			warnings: ["-ch_layout:v garbage selects no output stream and is ignored"],
		});
		expect(scope("lufs-norm - -ch_layout garbage -ch_layout 6C -o -".split(" "))).toMatchObject({
			scopes: { output: streamOf({ channelLayout: layout("6C", 6, 0) }) },
			warnings: ["-ch_layout is given more than once for the output; the last value, 6C, is used"],
		});

		for (const value of ["garbage", "+0x1p4"]) {
			expect(scope(["lufs-norm", "-", "-sample_rate", value, "-o", "-"])).toMatchObject({
				scopes: { output: DEFAULT_STREAM_OPTIONS },
				warnings: [`-sample_rate ${value} is ignored, as ffmpeg ignores -sample_rate on an output`],
			});
		}
	});

	it("parses no option after the last file", () => {
		expect(scope("stats a.wav -ar garbage".split(" ")).warnings).toEqual([
			"-ar garbage follows the last file and is ignored",
		]);
		expect(scope("stats a.wav -ar:foo 1".split(" ")).warnings).toEqual([
			"-ar:foo 1 follows the last file and is ignored",
		]);
	});

	it("applies an output option whose specifier selects the output's stream and ignores the rest with a warning", () => {
		expect(scope("lufs-norm - -ar:a 48000 -ac:a:0 2 -o -".split(" ")).scopes.output).toEqual(
			streamOf({ sampleRate: 48000, channelCount: 2 }),
		);

		for (const option of ["-ar:v", "-ar:u"]) {
			expect(scope(["lufs-norm", "-", option, "48000", "-o", "-"])).toMatchObject({
				scopes: { output: DEFAULT_STREAM_OPTIONS },
				warnings: [`${option} 48000 selects no output stream and is ignored`],
			});
		}
	});

	it.each([
		["", true],
		["a", true],
		["0", true],
		["a:0", true],
		["#0", true],
		["i:0", true],
		["a:#0", true],
		["0x0", true],
		["a:0x0", true],
		["v", false],
		["V", false],
		["t", false],
		["1", false],
		["a:1", false],
		["u", false],
		["m:language:eng", false],
		["p:0", false],
		["g:0", false],
		["disp:default", false],
		["disp:0", true],
		["a:disp:0", true],
		["disp:1", false],
		["disp:+default", false],
		["m:x:", false],
	])("reads output specifier %j as selecting the stream: %s", (specifier, selects) => {
		const scoped = scope(["lufs-norm", "-", `-ar:${specifier}`, "48000", "-o", "-"]);

		expect(scoped.scopes.output.sampleRate).toBe(selects ? 48000 : undefined);
	});

	it.each(["foo", "a:foo", "0:a", "#x", "aa", "a:v", "disp:nothing", "disp:1:disp:0", "m:x:y:z"])(
		"rejects the malformed specifier %j",
		(specifier) => {
			expect(() => scope(["stats", `-ar:${specifier}`, "48000", "in.raw"])).toThrow(
				`Invalid stream specifier "${specifier}" in -ar:${specifier}`,
			);
		},
	);

	it("reads -f without regard to letter case and refuses other formats", () => {
		expect(scope("stats -f S16LE a.raw -f WAV b.wav".split(" ")).scopes.inputs).toEqual([
			streamOf({ format: "s16le" }),
			DEFAULT_STREAM_OPTIONS,
		]);
		expect(() => scope("stats -f s16be a.raw".split(" "))).toThrow(
			'Unsupported format "s16be": use wav, u8, s16le, s24le, s32le, f32le or f64le',
		);
	});

	it("reads -sample_rate as one rounded number or a named constant", () => {
		const rateOf = (text: string): number | undefined =>
			scope(["stats", "-sample_rate", text, "in.raw"]).scopes.inputs[0]?.sampleRate;

		expect(
			[
				"48000.4",
				"48001.5",
				"48002.5",
				"20dB",
				"default",
				"max",
				" 48000 ",
				"min",
				"48 000",
				"--48000",
				" +max",
				"+0x10",
				"-20dB",
			].map(rateOf),
		).toEqual([48000, 48002, 48002, 10, 44100, 2147483647, 48000, 0, 48000, 48000, 2147483647, 16, 0]);
		expect(() => inputFormatOf(streamOf({ format: "s16le", sampleRate: rateOf("min") }), "-", undefined)).toThrow(
			"Invalid sample rate: 0",
		);

		for (const text of ["2*24000", "(48000)", "48000+0", "DEFAULT", "-1", "2147483648", "+0x1p4"]) {
			expect(() => rateOf(text)).toThrow(/^-sample_rate: /);
		}
	});

	it("warns of options after the last file and drops them", () => {
		expect(scope("lufs-norm - -o - -f f32le".split(" "))).toMatchObject({
			args: ["lufs-norm", "-", "-o", "-"],
			scopes: { inputs: [DEFAULT_STREAM_OPTIONS], output: DEFAULT_STREAM_OPTIONS },
			warnings: ["-f f32le follows the last file and is ignored"],
		});
		expect(scope("stats a.wav -ar 48000".split(" "))).toMatchObject({
			scopes: { inputs: [DEFAULT_STREAM_OPTIONS] },
			warnings: ["-ar 48000 follows the last file and is ignored"],
		});
		expect(scope("stats a.wav -ar 48000 -ac 2".split(" ")).warnings).toEqual([
			"-ar 48000 -ac 2 follow the last file and are ignored",
		]);
	});

	it("fails a stream option with no value", () => {
		expect(() => scope("stats a.raw -ar".split(" "))).toThrow("-ar needs a value");
	});

	it("leaves a stream option in front of the command name for Commander", () => {
		expect(scope("-f f32le lufs-norm - -o -".split(" "))).toMatchObject({
			args: ["-f", "f32le", "lufs-norm", "-", "-o", "-"],
			scopes: { inputs: [DEFAULT_STREAM_OPTIONS] },
		});
	});

	it("returns the args unchanged without a command", () => {
		expect(scope(["--version"])).toEqual({
			args: ["--version"],
			command: undefined,
			scopes: { inputs: [], output: DEFAULT_STREAM_OPTIONS },
			warnings: [],
		});
	});
});

describe("inputFormatOf", () => {
	const header: StreamFormat = { sampleRate: 48000, channelCount: 2, channelMask: 0, bitDepth: "16" };

	it("reads a raw input at 44100 Hz mono with no stated positions by default", () => {
		expect(inputFormatOf(streamOf({ format: "s16le" }), "-", undefined)).toEqual({
			sampleRate: 44100,
			channelCount: 1,
			channelMask: 0,
			bitDepth: "16",
		});
	});

	it("takes -ch_layout over -ac in either order", () => {
		const expected = { sampleRate: 44100, channelCount: 6, channelMask: 0x3f, bitDepth: "8" };

		for (const options of ["-ac 2 -ch_layout 5.1", "-ch_layout 5.1 -ac 2"]) {
			const stream = scope(["stats", "-f", "u8", ...options.split(" "), "in.raw"]).scopes.inputs[0];

			expect(inputFormatOf(stream ?? DEFAULT_STREAM_OPTIONS, "in.raw", undefined)).toEqual(expected);
		}
	});

	it.each([
		[{ sampleRate: -48000 }, "Invalid sample rate: -48000"],
		[{ sampleRate: 0 }, "Invalid sample rate: 0"],
		[{ sampleRate: 4 }, "Unsupported sample rate: 4"],
		[{ sampleRate: 768001 }, "Unsupported sample rate: 768001"],
		[{ sampleRate: 2147483647 }, "Unsupported sample rate: 2147483647"],
		[{ channelCount: 0 }, "Invalid channel count: 0; the most is 512"],
		[{ channelCount: 513 }, "Invalid channel count: 513; the most is 512"],
	])("fails a raw input with %j", (options, message) => {
		expect(() => inputFormatOf(streamOf({ format: "s16le", ...options }), "-", undefined)).toThrow(message);
	});

	it("reads 512 channels, 5 Hz and 768000 Hz on a raw input", () => {
		expect(inputFormatOf(streamOf({ format: "s16le", channelCount: 512, sampleRate: 5 }), "-", undefined)).toEqual({
			sampleRate: 5,
			channelCount: 512,
			channelMask: 0,
			bitDepth: "16",
		});
		expect(inputFormatOf(streamOf({ format: "s16le", sampleRate: 768000 }), "-", undefined).sampleRate).toBe(768000);
	});

	it("applies the 5 Hz and 768000 Hz limits to a WAV input", () => {
		for (const sampleRate of [4, 768001]) {
			expect(() => inputFormatOf(DEFAULT_STREAM_OPTIONS, "in.wav", { ...header, sampleRate })).toThrow(
				`Unsupported sample rate: ${sampleRate}`,
			);
		}

		for (const sampleRate of [5, 768000]) {
			expect(inputFormatOf(DEFAULT_STREAM_OPTIONS, "in.wav", { ...header, sampleRate }).sampleRate).toBe(sampleRate);
		}
	});

	it("refuses -ar on a WAV input, ignores -ac, and relabels it with a -ch_layout of its count", () => {
		expect(() => inputFormatOf(streamOf({ sampleRate: 48000 }), "in.wav", header)).toThrow(
			'-ar applies to a raw input, and "in.wav" is WAV',
		);

		for (const option of ["-sample_rate", "-ar:a"]) {
			const stream = scope(["stats", option, "22050", "in.wav"]).scopes.inputs[0];

			expect(() => inputFormatOf(stream ?? DEFAULT_STREAM_OPTIONS, "in.wav", header)).toThrow(
				`${option} applies to a raw input, and "in.wav" is WAV`,
			);
		}
		expect(inputFormatOf(streamOf({ channelCount: 6 }), "in.wav", header)).toEqual(header);
		expect(inputFormatOf(streamOf({ channelCount: 0 }), "in.wav", header)).toEqual(header);
		expect(inputFormatOf(streamOf({ channelLayout: layout("SL+SR", 2, 0x600) }), "in.wav", header)).toEqual({
			...header,
			channelMask: 0x600,
		});
		expect(() => inputFormatOf(streamOf({ channelLayout: layout("5.1", 6, 0x3f) }), "in.wav", header)).toThrow(
			'Channel layout "5.1" has 6 channels, and "in.wav" has 2',
		);
	});
});
