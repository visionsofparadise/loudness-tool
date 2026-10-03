import { channelLayoutOf, type ChannelLayout } from "./channelLayout";
import { ffmpegIntegerOf, sampleRateOptionOf } from "./ffmpegNumber";
import { selectsStream, streamSpecifierOf } from "./streamSpecifier";
import type { SourceBitDepth } from "../../wav/utils/wavFormat";
import type { StreamFormat } from "../../wav/WavReader";
import type { Command, Option } from "commander";

type RawFormatName = "u8" | "s16le" | "s24le" | "s32le" | "f32le" | "f64le";

export interface StreamOptions {
	readonly format: "wav" | RawFormatName;
	readonly sampleRate: number | undefined;
	readonly sampleRateOption: string | undefined;
	readonly channelCount: number | undefined;
	readonly channelLayout: ChannelLayout | undefined;
	readonly demuxerChannelLayout: ChannelLayout | undefined;
}

export const DEFAULT_STREAM_OPTIONS: StreamOptions = {
	format: "wav",
	sampleRate: undefined,
	sampleRateOption: undefined,
	channelCount: undefined,
	channelLayout: undefined,
	demuxerChannelLayout: undefined,
};

export interface StreamScopes {
	readonly inputs: ReadonlyArray<StreamOptions>;
	readonly output: StreamOptions;
}

const RAW_BIT_DEPTHS: Readonly<Record<RawFormatName, SourceBitDepth>> = {
	u8: "8",
	s16le: "16",
	s24le: "24",
	s32le: "32",
	f32le: "32f",
	f64le: "64f",
};
const RAW_DEFAULT_SAMPLE_RATE = 44100;
const RAW_DEFAULT_CHANNEL_COUNT = 1;
const MAXIMUM_CHANNEL_COUNT = 512;
const MINIMUM_SAMPLE_RATE = 5;
const MAXIMUM_SAMPLE_RATE = 768000;
const NEGATIVE_NUMBER = /^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/;
const STREAM_OPTION = /^-(f|ar|ac|ch_layout|channel_layout|sample_rate)(?::(.*))?$/s;
const LAYOUT_OPTIONS = ["ch_layout", "channel_layout"];

export const rawBitDepthOf = (format: RawFormatName): SourceBitDepth => RAW_BIT_DEPTHS[format];

const isRawFormatName = (value: string): value is RawFormatName => Object.hasOwn(RAW_BIT_DEPTHS, value);

interface Occurrence {
	readonly option: string;
	readonly name: string;
	readonly specifier: string | undefined;
	readonly text: string;
}

interface ReadOccurrence extends Occurrence {
	readonly selects: boolean;
	readonly number: number | undefined;
}

const formatOf = (text: string | undefined): StreamOptions["format"] => {
	const format = (text ?? "wav").toLowerCase();

	if (format !== "wav" && !isRawFormatName(format)) {
		throw new Error(`Unsupported format "${text ?? ""}": use wav, u8, s16le, s24le, s32le, f32le or f64le`);
	}

	return format;
};

const occurrenceOf = (token: string, text: string | undefined): Occurrence | undefined => {
	const match = STREAM_OPTION.exec(token);
	const name = match?.[1];

	if (match === null || name === undefined || (name === "sample_rate" && match[2] !== undefined)) {
		return undefined;
	}

	if (text === undefined) {
		throw new Error(`${token} needs a value`);
	}

	return { option: token, name, specifier: name === "f" ? undefined : match[2], text };
};

const readOccurrenceOf = (occurrence: Occurrence, isInput: boolean): ReadOccurrence => {
	const { option, name, specifier, text } = occurrence;
	const parsed = specifier === undefined ? undefined : streamSpecifierOf(specifier);

	if (specifier !== undefined && parsed === undefined) {
		throw new Error(`Invalid stream specifier "${specifier}" in ${option}`);
	}

	return {
		...occurrence,
		selects: parsed === undefined || selectsStream(parsed, isInput),
		number: name === "ar" || name === "ac" ? ffmpegIntegerOf(option, text) : undefined,
	};
};

const lastOf = (occurrences: ReadonlyArray<ReadOccurrence>, names: ReadonlyArray<string>): ReadOccurrence | undefined =>
	occurrences.filter((occurrence) => names.includes(occurrence.name)).at(-1);

const layoutOf = (occurrence: ReadOccurrence | undefined): ChannelLayout | undefined =>
	occurrence === undefined ? undefined : channelLayoutOf(occurrence.text);

const repeatWarningOf = (
	occurrences: ReadonlyArray<ReadOccurrence>,
	names: ReadonlyArray<string>,
	target: string,
): Array<string> => {
	const repeats = occurrences.filter((occurrence) => occurrence.selects && names.includes(occurrence.name));
	const last = repeats.at(-1);

	return repeats.length > 1 && last !== undefined
		? [`-${last.name} is given more than once for ${target}; the last value, ${last.text}, is used`]
		: [];
};

// eslint-disable-next-line comment-rules/no-restricted-comments
// As FFmpeg 8.0 fftools/ffmpeg_demux.c hands an input's options to its demuxer, whatever their specifiers: the last -ar over the raw demuxer's own sample_rate AVOption, the last -ac as <n>C, and the last -ch_layout over that, a layout only to a demuxer with a ch_layout option; and as its audio stream takes the last -ch_layout whose specifier selects it, through fftools/ffmpeg_opt.c opt_match_per_stream.
const inputStreamOptionsOf = (
	occurrences: ReadonlyArray<Occurrence>,
	path: string,
): { readonly options: StreamOptions; readonly warnings: ReadonlyArray<string> } => {
	const read = occurrences.map((occurrence) => readOccurrenceOf(occurrence, true));
	const format = formatOf(lastOf(read, ["f"])?.text);
	const rate = lastOf(read, ["ar"]) ?? lastOf(read, ["sample_rate"]);
	const layouts = read.filter((occurrence) => LAYOUT_OPTIONS.includes(occurrence.name));

	return {
		options: {
			format,
			sampleRate: rate === undefined ? undefined : (rate.number ?? sampleRateOptionOf(rate.text)),
			sampleRateOption: rate?.option,
			channelCount: lastOf(read, ["ac"])?.number,
			channelLayout: layoutOf(layouts.filter((occurrence) => occurrence.selects).at(-1)),
			demuxerChannelLayout: format === "wav" ? undefined : layoutOf(layouts.at(-1)),
		},
		warnings: repeatWarningOf(read, LAYOUT_OPTIONS, `the input "${path}"`),
	};
};

const outputStreamOptionsOf = (
	occurrences: ReadonlyArray<Occurrence>,
): { readonly options: StreamOptions; readonly warnings: ReadonlyArray<string> } => {
	const ignored: Array<string> = [];
	const applied = occurrences
		.map((occurrence) => readOccurrenceOf(occurrence, false))
		.filter((occurrence) => {
			if (occurrence.name === "sample_rate") {
				ignored.push(
					`${occurrence.option} ${occurrence.text} is ignored, as ffmpeg ignores -sample_rate on an output`,
				);

				return false;
			}

			if (!occurrence.selects) {
				ignored.push(`${occurrence.option} ${occurrence.text} selects no output stream and is ignored`);
			}

			return occurrence.selects;
		});

	return {
		options: {
			format: formatOf(lastOf(applied, ["f"])?.text),
			sampleRate: lastOf(applied, ["ar"])?.number,
			sampleRateOption: undefined,
			channelCount: lastOf(applied, ["ac"])?.number,
			channelLayout: layoutOf(lastOf(applied, LAYOUT_OPTIONS)),
			demuxerChannelLayout: undefined,
		},
		warnings: [
			...ignored,
			...repeatWarningOf(applied, ["ar"], "the output"),
			...repeatWarningOf(applied, ["ac"], "the output"),
			...repeatWarningOf(applied, LAYOUT_OPTIONS, "the output"),
		],
	};
};

const maybeOption = (token: string): boolean => token.length > 1 && token.startsWith("-");

const optionOf = (options: ReadonlyArray<Option>, token: string): Option | undefined =>
	options.find((option) => option.short === token || option.long === token);

const valueCountOf = (option: Option, next: string | undefined): number => {
	if (option.required) {
		return next === undefined ? 0 : 1;
	}

	if (option.optional && next !== undefined && (!maybeOption(next) || NEGATIVE_NUMBER.test(next))) {
		return 1;
	}

	return 0;
};

const commandNamed = (program: Command, token: string): Command | undefined =>
	program.commands.find((command) => command.name() === token || command.aliases().includes(token));

const isOutputToken = (option: Option | undefined, token: string): "separate" | "joined" | undefined => {
	if (option === undefined) {
		return undefined;
	}

	if (token === option.short || token === option.long) {
		return "separate";
	}

	if (
		(option.short !== undefined && token.length > option.short.length && token.startsWith(option.short)) ||
		(option.long !== undefined && token.startsWith(`${option.long}=`))
	) {
		return "joined";
	}

	return undefined;
};

export const scopeStreamArguments = (
	args: ReadonlyArray<string>,
	program: Command,
): {
	readonly args: Array<string>;
	readonly command: Command | undefined;
	readonly scopes: StreamScopes;
	readonly warnings: ReadonlyArray<string>;
} => {
	const scoped: Array<string> = [];
	const warnings: Array<string> = [];
	const inputs: Array<StreamOptions> = [];
	let output = DEFAULT_STREAM_OPTIONS;
	let pending: Array<Occurrence> = [];
	let command: Command | undefined;
	let index = 0;

	while (index < args.length && command === undefined) {
		const token = args[index++] ?? "";
		const option = optionOf(program.options, token);

		scoped.push(token);

		if (option !== undefined) {
			const count = valueCountOf(option, args[index]);

			scoped.push(...args.slice(index, index + count));
			index += count;
		} else {
			command = commandNamed(program, token);
		}
	}

	if (command === undefined) {
		return { args: [...args], command, scopes: { inputs, output }, warnings };
	}

	const options = [...program.options, ...command.options];
	const outputOption = command.options.find((option) => option.attributeName() === "output");
	const closeInput = (path: string): void => {
		const scoped = inputStreamOptionsOf(pending, path);

		warnings.push(...scoped.warnings);
		inputs.push(scoped.options);
		pending = [];
	};
	const closeOutput = (): void => {
		const scoped = outputStreamOptionsOf(pending);

		warnings.push(...scoped.warnings);
		output = scoped.options;
		pending = [];
	};
	let isAfterSeparator = false;

	while (index < args.length) {
		const token = args[index++] ?? "";

		if (isAfterSeparator) {
			closeInput(token);
			scoped.push(token);

			continue;
		}

		const occurrence = occurrenceOf(token, args[index]);

		if (occurrence !== undefined) {
			pending.push(occurrence);
			index++;

			continue;
		}

		scoped.push(token);

		const outputForm = isOutputToken(outputOption, token);

		if (outputForm !== undefined) {
			if (outputForm === "separate" && index < args.length) {
				scoped.push(args[index++] ?? "");
			}

			closeOutput();

			continue;
		}

		if (token === "--") {
			isAfterSeparator = true;

			continue;
		}

		const option = optionOf(options, token);

		if (option !== undefined) {
			const count = valueCountOf(option, args[index]);

			scoped.push(...args.slice(index, index + count));
			index += count;
		} else if (!maybeOption(token) || NEGATIVE_NUMBER.test(token)) {
			closeInput(token);
		}
	}

	if (pending.length > 0) {
		const given = pending.map((occurrence) => `${occurrence.option} ${occurrence.text}`).join(" ");

		warnings.push(
			pending.length === 1
				? `${given} follows the last file and is ignored`
				: `${given} follow the last file and are ignored`,
		);
	}

	return { args: scoped, command, scopes: { inputs, output }, warnings };
};

export const inputFormatOf = (stream: StreamOptions, label: string, header: StreamFormat | undefined): StreamFormat => {
	const format = header === undefined ? rawInputFormatOf(stream, label) : wavInputFormatOf(stream, label, header);

	if (format.sampleRate < MINIMUM_SAMPLE_RATE || format.sampleRate > MAXIMUM_SAMPLE_RATE) {
		throw new Error(`Unsupported sample rate: ${format.sampleRate}`);
	}

	return format;
};

const layoutMaskOf = (layout: ChannelLayout | undefined, channelCount: number, label: string): number | undefined => {
	if (layout !== undefined && layout.channelCount !== channelCount) {
		throw new Error(
			`Channel layout "${layout.name}" has ${layout.channelCount} channels, and "${label}" has ${channelCount}`,
		);
	}

	return layout?.channelMask;
};

const rawInputFormatOf = (stream: StreamOptions, label: string): StreamFormat => {
	if (stream.format === "wav") {
		throw new Error("A raw input needs a raw format");
	}

	const sampleRate = stream.sampleRate ?? RAW_DEFAULT_SAMPLE_RATE;
	const demuxerLayout = stream.demuxerChannelLayout;
	const channelCount = demuxerLayout?.channelCount ?? stream.channelCount ?? RAW_DEFAULT_CHANNEL_COUNT;

	if (sampleRate <= 0) {
		throw new Error(`Invalid sample rate: ${sampleRate}`);
	}

	if (channelCount < 1 || channelCount > MAXIMUM_CHANNEL_COUNT) {
		throw new Error(`Invalid channel count: ${channelCount}; the most is ${MAXIMUM_CHANNEL_COUNT}`);
	}

	return {
		sampleRate,
		channelCount,
		channelMask: layoutMaskOf(stream.channelLayout, channelCount, label) ?? demuxerLayout?.channelMask ?? 0,
		bitDepth: rawBitDepthOf(stream.format),
	};
};

const wavInputFormatOf = (stream: StreamOptions, label: string, header: StreamFormat): StreamFormat => {
	if (stream.sampleRate !== undefined) {
		throw new Error(`${stream.sampleRateOption ?? "-ar"} applies to a raw input, and "${label}" is WAV`);
	}

	return {
		...header,
		channelMask: layoutMaskOf(stream.channelLayout, header.channelCount, label) ?? header.channelMask,
	};
};

export const STREAM_OPTIONS_HELP = `
Stream options, as in ffmpeg, each applying to the input or -o output that follows it:
  -f <format>          wav (the default), or raw PCM: u8, s16le, s24le, s32le, f32le or f64le
  -ar <rate>           raw input sample rate in Hz (default 44100; -sample_rate on an input); on an output, the input's rate or 0
  -ac <channels>       raw input channel count (default 1); on an output, the input's count or 0
  -ch_layout <layout>  channel layout, such as 5.1, FL+FR+LFE, 0x3f or 6C (also -channel_layout); outranks -ac
Sample rates below 5 Hz or above 768000 Hz are not supported.`;
