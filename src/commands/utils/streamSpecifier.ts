import { avTokenOf } from "./channelLayout";
import { avStrtodOf, cStrtolOf, roundHalfToEven } from "./ffmpegNumber";

export interface StreamSpecifier {
	readonly index: number;
	readonly mediaType: string | undefined;
	readonly list: "all" | "stream" | "program" | "group";
	readonly listId: number;
	readonly hasMetadata: boolean;
	readonly disposition: number;
	readonly isUsableOnly: boolean;
}

const UINT32_LIMIT = 2 ** 32;
const INT64_LIMIT = 2 ** 63;

// eslint-disable-next-line comment-rules/no-restricted-comments
// The AV_DISPOSITION_* flags of FFmpeg 8.0 libavformat/avformat.h, which libavformat/options_table.h names as the constants of AVStream's disposition option, and libavutil/eval.c's own constants.
const DISPOSITION_FLAGS: Readonly<Record<string, number>> = {
	default: 0x1,
	dub: 0x2,
	original: 0x4,
	comment: 0x8,
	lyrics: 0x10,
	karaoke: 0x20,
	forced: 0x40,
	hearing_impaired: 0x80,
	visual_impaired: 0x100,
	clean_effects: 0x200,
	attached_pic: 0x400,
	timed_thumbnails: 0x800,
	non_diegetic: 0x1000,
	captions: 0x10000,
	descriptions: 0x20000,
	metadata: 0x40000,
	dependent: 0x80000,
	still_image: 0x100000,
	multilayer: 0x200000,
};
const DISPOSITION_CONSTANTS: Readonly<Record<string, number>> = {
	...DISPOSITION_FLAGS,
	max: 0,
	min: 0,
	none: 0,
	all: -1,
	E: Math.E,
	PI: Math.PI,
	PHI: 1.618033988749895,
	QP2LAMBDA: 118,
};

const isAlphanumeric = (character: string): boolean => /^[\dA-Za-z]$/.test(character);

const isIdentifierCharacter = (character: string): boolean => /^[\dA-Za-z_]$/.test(character);

// eslint-disable-next-line comment-rules/no-restricted-comments
// Ports FFmpeg 8.0 libavutil/eval.c over a disposition term, whose characters are letters, digits, _ and +: parse_subexpr's sum of terms, parse_pow's one unary +, and parse_primary's av_strtod number or named constant, ended by a character no identifier holds.
const expressionValueOf = (text: string): number | undefined => {
	let position = 0;
	let sum = 0;

	for (;;) {
		if (text.charAt(position) === "+") {
			position++;
		}

		const rest = text.slice(position);
		const number = avStrtodOf(rest);
		const name = Object.keys(DISPOSITION_CONSTANTS).find(
			(constant) => rest.startsWith(constant) && !isIdentifierCharacter(rest.charAt(constant.length)),
		);

		if (number.rest.length < rest.length) {
			sum += number.value;
			position += rest.length - number.rest.length;
		} else if (name === undefined) {
			return undefined;
		} else {
			sum += DISPOSITION_CONSTANTS[name] ?? 0;
			position += name.length;
		}

		if (position === text.length) {
			return sum;
		}

		if (text.charAt(position) !== "+") {
			return undefined;
		}
	}
};

// eslint-disable-next-line comment-rules/no-restricted-comments
// Ports FFmpeg 8.0 libavutil/opt.c av_opt_eval_flags over AVStream's disposition option: set_string_number's + commands, each term a disposition name or an expression, and write_number's check that the value is a set of 32-bit flags.
const dispositionOf = (text: string): number | undefined => {
	let value = 0;
	let rest = text;

	for (;;) {
		const isOr = rest.startsWith("+");

		rest = isOr ? rest.slice(1) : rest;

		const length = /^[^+-]*/.exec(rest)?.[0].length ?? 0;
		const term = length > 0 ? rest.slice(0, length) : rest;
		const named = Object.hasOwn(DISPOSITION_FLAGS, term) ? DISPOSITION_FLAGS[term] : expressionValueOf(term);

		if (named === undefined || !Number.isFinite(named) || Math.abs(named) >= INT64_LIMIT) {
			return undefined;
		}

		const flags = isOr ? Number(BigInt(value) | BigInt(Math.trunc(named))) : named;

		if (flags < -1.5 || flags > 0xffffffff + 0.5 || BigInt(roundHalfToEven(flags * 256)) % 256n !== 0n) {
			return undefined;
		}

		value = ((roundHalfToEven(flags) % UINT32_LIMIT) + UINT32_LIMIT) % UINT32_LIMIT;
		rest = rest.slice(length);

		if (length === 0 || rest.length === 0) {
			return value;
		}
	}
};

// eslint-disable-next-line comment-rules/no-restricted-comments
// Ports FFmpeg 8.0 fftools/cmdutils.c stream_specifier_parse without a remainder; undefined where it fails.
export const streamSpecifierOf = (specifier: string): StreamSpecifier | undefined => {
	let rest = specifier;
	let index = -1;
	let mediaType: string | undefined;
	let list: StreamSpecifier["list"] = "all";
	let listId = 0;
	let hasMetadata = false;
	let disposition = 0;
	let isUsableOnly = false;
	const takeListId = (): boolean => {
		const parsed = cStrtolOf(rest);

		listId = parsed.value;
		rest = rest.slice(parsed.length);

		return parsed.length > 0;
	};

	while (rest.length > 0) {
		const first = rest.charAt(0);
		const second = rest.charAt(1);

		if (first >= "0" && first <= "9") {
			const parsed = cStrtolOf(rest);

			index = parsed.value;
			rest = rest.slice(parsed.length);

			break;
		} else if ("vasdtV".includes(first) && !isAlphanumeric(second)) {
			if (mediaType !== undefined) {
				return undefined;
			}

			mediaType = first;
			rest = rest.slice(1);
		} else if ((first === "g" || first === "p") && second === ":") {
			if (list !== "all") {
				return undefined;
			}

			list = first === "g" ? "group" : "program";
			rest = rest.slice(2);

			if (first === "g" && (rest.startsWith("#") || rest.startsWith("i:"))) {
				rest = rest.slice(rest.startsWith("#") ? 1 : 2);
			}

			if (!takeListId()) {
				return undefined;
			}
		} else if (rest.startsWith("disp:")) {
			const flags = /^[\dA-Za-z_+]*/.exec(rest.slice(5))?.[0] ?? "";
			const value = disposition === 0 ? dispositionOf(flags) : undefined;

			if (value === undefined) {
				return undefined;
			}

			disposition = value;
			rest = rest.slice(5 + flags.length);
		} else if (first === "#" || (first === "i" && second === ":")) {
			if (list !== "all") {
				return undefined;
			}

			list = "stream";
			rest = rest.slice(first === "#" ? 1 : 2);

			if (!takeListId()) {
				return undefined;
			}

			break;
		} else if (first === "m" && second === ":") {
			const key = avTokenOf(rest.slice(2), ":");

			hasMetadata = true;
			rest = key.rest.startsWith(":") ? avTokenOf(key.rest.slice(1), ":").rest : key.rest;

			break;
		} else if (first === "u" && (second === "" || second === ":")) {
			isUsableOnly = true;
			rest = rest.slice(1);

			break;
		} else {
			break;
		}

		if (rest.startsWith(":")) {
			rest = rest.slice(1);
		}
	}

	return rest.length > 0 ? undefined : { index, mediaType, list, listId, hasMetadata, disposition, isUsableOnly };
};

// eslint-disable-next-line comment-rules/no-restricted-comments
// Ports FFmpeg 8.0 fftools/cmdutils.c stream_specifier_match against loudness-tool's one stream: audio, index 0, id 0, with no metadata, program, group or disposition, and usable on an input, whose demuxer has filled its parameters, and not yet on an output.
export const selectsStream = (specifier: StreamSpecifier, isUsable: boolean): boolean =>
	(specifier.mediaType === undefined || specifier.mediaType === "a") &&
	(specifier.list === "all" || (specifier.list === "stream" && specifier.listId === 0)) &&
	!specifier.hasMetadata &&
	specifier.disposition === 0 &&
	(!specifier.isUsableOnly || isUsable) &&
	specifier.index <= 0;
