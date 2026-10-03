import { cStrtolOf } from "./ffmpegNumber";

export interface ChannelLayout {
	readonly name: string;
	readonly channelCount: number;
	readonly channelMask: number;
}

const WAVE_MASK_LIMIT = 0x40000n;
const CHANNEL_COUNT = 18;
const MAXIMUM_COUNT = 2147483647;
const TOKEN_WHITESPACE = " \n\t\r";

// eslint-disable-next-line comment-rules/no-restricted-comments
// Channel names and bits per FFmpeg 8.0 libavutil/channel_layout.c channel_names, whose first 18 bits are the Microsoft WAVEFORMATEXTENSIBLE dwChannelMask SPEAKER_* bits; standard layouts per `ffmpeg -layouts`; parsing per av_channel_layout_from_string, parse_channel_list, av_channel_from_string (USR<n> through strtol base 0), av_channel_layout_retype's canonical order (a list of unlabelled UNK channels is unspecified) and libavutil/avstring.c av_get_token.
const CHANNEL_BITS: Readonly<Record<string, number>> = {
	FL: 0x1,
	FR: 0x2,
	FC: 0x4,
	LFE: 0x8,
	BL: 0x10,
	BR: 0x20,
	FLC: 0x40,
	FRC: 0x80,
	BC: 0x100,
	SL: 0x200,
	SR: 0x400,
	TC: 0x800,
	TFL: 0x1000,
	TFC: 0x2000,
	TFR: 0x4000,
	TBL: 0x8000,
	TBC: 0x10000,
	TBR: 0x20000,
};

const FFMPEG_ONLY_CHANNELS = new Set([
	"DL",
	"DR",
	"WL",
	"WR",
	"SDL",
	"SDR",
	"LFE2",
	"TSL",
	"TSR",
	"BFC",
	"BFL",
	"BFR",
	"SSL",
	"SSR",
	"TTL",
	"TTR",
	"BIL",
	"BIR",
	"UNSD",
]);

const STANDARD_LAYOUTS: Readonly<Record<string, string | undefined>> = {
	mono: "FC",
	stereo: "FL+FR",
	"2.1": "FL+FR+LFE",
	"3.0": "FL+FR+FC",
	"3.0(back)": "FL+FR+BC",
	"4.0": "FL+FR+FC+BC",
	quad: "FL+FR+BL+BR",
	"quad(side)": "FL+FR+SL+SR",
	"3.1": "FL+FR+FC+LFE",
	"5.0": "FL+FR+FC+BL+BR",
	"5.0(side)": "FL+FR+FC+SL+SR",
	"4.1": "FL+FR+FC+LFE+BC",
	"5.1": "FL+FR+FC+LFE+BL+BR",
	"5.1(side)": "FL+FR+FC+LFE+SL+SR",
	"6.0": "FL+FR+FC+BC+SL+SR",
	"6.0(front)": "FL+FR+FLC+FRC+SL+SR",
	"3.1.2": "FL+FR+FC+LFE+TFL+TFR",
	hexagonal: "FL+FR+FC+BL+BR+BC",
	"6.1": "FL+FR+FC+LFE+BC+SL+SR",
	"6.1(back)": "FL+FR+FC+LFE+BL+BR+BC",
	"6.1(front)": "FL+FR+LFE+FLC+FRC+SL+SR",
	"7.0": "FL+FR+FC+BL+BR+SL+SR",
	"7.0(front)": "FL+FR+FC+FLC+FRC+SL+SR",
	"7.1": "FL+FR+FC+LFE+BL+BR+SL+SR",
	"7.1(wide)": "FL+FR+FC+LFE+BL+BR+FLC+FRC",
	"7.1(wide-side)": "FL+FR+FC+LFE+FLC+FRC+SL+SR",
	"5.1.2": "FL+FR+FC+LFE+SL+SR+TFL+TFR",
	"5.1.2(back)": "FL+FR+FC+LFE+BL+BR+TFL+TFR",
	octagonal: "FL+FR+FC+BL+BR+BC+SL+SR",
	cube: "FL+FR+BL+BR+TFL+TFR+TBL+TBR",
	"5.1.4": "FL+FR+FC+LFE+SL+SR+TFL+TFR+TBL+TBR",
	"7.1.2": "FL+FR+FC+LFE+BL+BR+SL+SR+TFL+TFR",
	"7.1.4": "FL+FR+FC+LFE+BL+BR+SL+SR+TFL+TFR+TBL+TBR",
	"7.2.3": undefined,
	"9.1.4": "FL+FR+FC+LFE+BL+BR+FLC+FRC+SL+SR+TFL+TFR+TBL+TBR",
	"9.1.6": undefined,
	hexadecagonal: undefined,
	binaural: undefined,
	downmix: undefined,
	"22.2": undefined,
};

class UnsupportedLayout extends Error {}

const unsupportedLayoutErrorOf = (value: string): Error =>
	new Error(
		`Unsupported channel layout "${value}": use a standard layout or channel names joined by + within the WAVE channel mask, such as 5.1 or FL+FR+LFE, a channel mask such as 0x3f, or a channel count such as 6C`,
	);

const popcountOf = (mask: bigint): number => mask.toString(2).replaceAll("0", "").length;

const layoutOfMask = (name: string, mask: bigint): ChannelLayout => {
	if (mask >= WAVE_MASK_LIMIT) {
		throw new UnsupportedLayout();
	}

	return { name, channelCount: popcountOf(mask), channelMask: Number(mask) };
};

export const avTokenOf = (text: string, terminators: string): { readonly token: string; readonly rest: string } => {
	let index = 0;
	let token = "";
	let protectedLength = 0;

	while (index < text.length && TOKEN_WHITESPACE.includes(text.charAt(index))) {
		index++;
	}

	while (index < text.length && !terminators.includes(text.charAt(index))) {
		const character = text.charAt(index++);

		if (character === "\\" && index < text.length) {
			token += text.charAt(index++);
			protectedLength = token.length;
		} else if (character === "'") {
			while (index < text.length && text.charAt(index) !== "'") {
				token += text.charAt(index++);
			}

			if (index < text.length) {
				index++;
				protectedLength = token.length;
			}
		} else {
			token += character;
		}
	}

	let end = token.length;

	while (end > protectedLength && TOKEN_WHITESPACE.includes(token.charAt(end - 1))) {
		end--;
	}

	return { token: token.slice(0, end), rest: text.slice(index) };
};

const hasLabel = (text: string): boolean => {
	const key = /^[ \n\t\r]*[\dA-Za-z./_-]*[ \n\t\r]*@/.exec(text);

	return key !== null;
};

const channelIdOf = (name: string): number | "unknown" | "beyond" | undefined => {
	const bit = CHANNEL_BITS[name];

	if (bit !== undefined) {
		return bit;
	}

	if (name === "UNK") {
		return "unknown";
	}

	if (FFMPEG_ONLY_CHANNELS.has(name) || name.startsWith("AMBI")) {
		return "beyond";
	}

	if (!name.startsWith("USR")) {
		return undefined;
	}

	const id = cStrtolOf(name.slice(3));

	if (id.length < name.length - 3 || id.value < 0) {
		return undefined;
	}

	return id.value < CHANNEL_COUNT ? 1 << id.value : "beyond";
};

const channelListOf = (list: string): { readonly count: number; readonly mask: number } | undefined => {
	let rest = list;
	let mask = 0;
	let previous = 0;
	let count = 0;
	let unknownCount = 0;
	let isWaveMask = true;

	while (rest.length > 0) {
		const isLabelled = hasLabel(rest);
		const keyEnd = isLabelled ? rest.indexOf("@") : -1;
		const { token, rest: after } = avTokenOf(isLabelled ? rest.slice(keyEnd + 1) : rest, "+");
		const id = channelIdOf(isLabelled ? rest.slice(0, keyEnd).trim() : token);

		rest = after.length > 0 ? after.slice(1) : after;
		count++;

		if (id === undefined) {
			return undefined;
		}

		if (isLabelled && token.length > 0) {
			isWaveMask = false;
		} else if (id === "unknown") {
			unknownCount++;
		} else if (id === "beyond" || id <= previous) {
			isWaveMask = false;
		} else {
			mask |= id;
			previous = id;
		}
	}

	if (count === 0) {
		return undefined;
	}

	if (isWaveMask && unknownCount === count) {
		return { count, mask: 0 };
	}

	if (!isWaveMask || unknownCount > 0) {
		throw new UnsupportedLayout();
	}

	return { count, mask };
};

const cIntegerPrefixOf = (text: string): { readonly value: number; readonly rest: string } | undefined => {
	const match = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(text);

	if (match === null) {
		return undefined;
	}

	return { value: Number(match[1]), rest: text.slice(match[0].length) };
};

const channelsPatternOf = (value: string): { readonly count: number; readonly list: string } | undefined => {
	const count = cIntegerPrefixOf(value);
	const match = count === undefined ? null : /^[ \t\n\v\f\r]*channels[ \t\n\v\f\r]*\(([^)]+)/.exec(count.rest);

	return count === undefined || match === null ? undefined : { count: count.value, list: match[1] ?? "" };
};

const cMaskOf = (value: string): bigint | undefined => {
	const match = /^[ \t\n\v\f\r]*([+-]?)(0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)$/.exec(value);

	if (match === null || value.includes("-")) {
		return undefined;
	}

	const digits = match[2] ?? "";
	const mask = /^0[0-7]+$/.test(digits) ? BigInt(`0o${digits.slice(1)}`) : BigInt(digits);

	return mask > 0xffffffffffffffffn ? undefined : mask;
};

const parseLayout = (value: string): ChannelLayout => {
	if (Object.hasOwn(STANDARD_LAYOUTS, value)) {
		const decomposition = STANDARD_LAYOUTS[value];

		if (decomposition === undefined) {
			throw new UnsupportedLayout();
		}

		return layoutOfMask(value, BigInt(channelListOf(decomposition)?.mask ?? 0));
	}

	if (value.startsWith("ambisonic ")) {
		throw new UnsupportedLayout();
	}

	const pattern = channelsPatternOf(value);
	const channels = channelListOf(pattern?.list ?? value);

	if (channels !== undefined) {
		const layout = { name: value, channelCount: channels.count, channelMask: channels.mask };
		const close = value.indexOf(")");

		if (pattern !== undefined && (pattern.count !== layout.channelCount || close !== value.length - 1)) {
			throw new UnsupportedLayout();
		}

		return layout;
	}

	const mask = cMaskOf(value);

	if (mask !== undefined && mask !== 0n) {
		return layoutOfMask(value, mask);
	}

	const count = cIntegerPrefixOf(value);

	if (count !== undefined && count.value > 0 && count.value <= MAXIMUM_COUNT) {
		if (count.rest === "C" || count.rest === " channels") {
			return { name: value, channelCount: count.value, channelMask: 0 };
		}
	}

	throw new UnsupportedLayout();
};

export const channelLayoutOf = (value: string): ChannelLayout => {
	try {
		return parseLayout(value);
	} catch (error) {
		if (error instanceof UnsupportedLayout) {
			throw unsupportedLayoutErrorOf(value);
		}

		throw error;
	}
};
