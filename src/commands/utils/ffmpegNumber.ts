const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const SAMPLE_RATE_CONSTANTS: Readonly<Record<string, number>> = { default: 44100, min: 0, max: INT_MAX };
const M_LOG2_10 = 3.321928094887362;
const C_WHITESPACE = /^[ \t\n\v\f\r]*/;
const C_SPACE = /[ \t\n\v\f\r]/g;
const C_LONG = /^[ \t\n\v\f\r]*[+-]?(?:0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)/;

// eslint-disable-next-line comment-rules/no-restricted-comments
// Ports FFmpeg 8.0 libavutil/eval.c (av_strtod, si_prefixes, ff_exp10 for dB) under fftools/cmdutils.c parse_number for an int option, and, for the -sample_rate AVOption, av_expr_parse's whitespace removal, parse_dB's and parse_pow's unary sign and one primary, a number or the option's default, min and max constants, rounded by llrint.
const SI_PREFIXES: Readonly<Record<string, { readonly binary: number; readonly decimal: number }>> = {
	y: { binary: 8.271806125530276749e-25, decimal: 1e-24 },
	z: { binary: 8.4703294725430034e-22, decimal: 1e-21 },
	a: { binary: 8.6736173798840355e-19, decimal: 1e-18 },
	f: { binary: 8.8817841970012523e-16, decimal: 1e-15 },
	p: { binary: 9.0949470177292824e-13, decimal: 1e-12 },
	n: { binary: 9.3132257461547852e-10, decimal: 1e-9 },
	u: { binary: 9.5367431640625e-7, decimal: 1e-6 },
	m: { binary: 9.765625e-4, decimal: 1e-3 },
	c: { binary: 9.8431332023036951e-3, decimal: 1e-2 },
	d: { binary: 9.921256574801246e-2, decimal: 1e-1 },
	h: { binary: 1.0159366732596479e2, decimal: 1e2 },
	k: { binary: 1.024e3, decimal: 1e3 },
	K: { binary: 1.024e3, decimal: 1e3 },
	M: { binary: 1.048576e6, decimal: 1e6 },
	G: { binary: 1.073741824e9, decimal: 1e9 },
	T: { binary: 1.099511627776e12, decimal: 1e12 },
	P: { binary: 1.125899906842624e15, decimal: 1e15 },
	E: { binary: 1.152921504606847e18, decimal: 1e18 },
	Z: { binary: 1.1805916207174113e21, decimal: 1e21 },
	Y: { binary: 1.2089258196146292e24, decimal: 1e24 },
};

const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const HEXADECIMAL_NUMBER = /^[+-]?0[xX](?:[\da-fA-F]+\.?[\da-fA-F]*|\.[\da-fA-F]+)(?:[pP][+-]?\d+)?/;
const SPECIAL_NUMBER = /^[+-]?(?:infinity|inf|nan(?:\([\dA-Za-z_]*\))?)/i;

const hexadecimalFloatOf = (text: string): number => {
	const match = /^([+-]?)0[xX]([\da-fA-F]*)\.?([\da-fA-F]*)(?:[pP]([+-]?\d+))?$/.exec(text);
	const [, sign = "", whole = "", fraction = "", exponent = "0"] = match ?? [];
	const mantissa = Number.parseInt(`${whole}${fraction}` || "0", 16);
	const value = mantissa * 2 ** (Number(exponent) - 4 * fraction.length);

	return sign === "-" ? -value : value;
};

const cStrtodOf = (text: string): { readonly value: number; readonly length: number } | undefined => {
	const leading = C_WHITESPACE.exec(text)?.[0].length ?? 0;
	const rest = text.slice(leading);
	const hexadecimal = HEXADECIMAL_NUMBER.exec(rest)?.[0];

	if (hexadecimal !== undefined) {
		return { value: hexadecimalFloatOf(hexadecimal), length: leading + hexadecimal.length };
	}

	const decimal = DECIMAL_NUMBER.exec(rest)?.[0];

	if (decimal !== undefined) {
		return { value: Number(decimal), length: leading + decimal.length };
	}

	const special = SPECIAL_NUMBER.exec(rest)?.[0];

	if (special !== undefined) {
		const isNegative = special.startsWith("-");
		const value = /nan/i.test(special) ? Number.NaN : Number.POSITIVE_INFINITY;

		return { value: isNegative ? -value : value, length: leading + special.length };
	}

	return undefined;
};

export const avStrtodOf = (text: string): { readonly value: number; readonly rest: string } => {
	let parsed: { value: number; length: number } | undefined;

	if (/^0[xX]/.test(text)) {
		const digits = /^[\da-fA-F]*/.exec(text.slice(2))?.[0] ?? "";

		parsed =
			digits.length === 0
				? { value: 0, length: 1 }
				: { value: Number.parseInt(digits, 16), length: 2 + digits.length };
	} else {
		parsed = cStrtodOf(text);
	}

	if (parsed === undefined) {
		return { value: 0, rest: text };
	}

	let { value } = parsed;
	let rest = text.slice(parsed.length);

	if (rest.startsWith("dB")) {
		value = 2 ** (M_LOG2_10 * (value / 20));
		rest = rest.slice(2);
	} else {
		const prefix = SI_PREFIXES[rest.charAt(0)];

		if (prefix !== undefined) {
			value *= rest.charAt(1) === "i" ? prefix.binary : prefix.decimal;
			rest = rest.slice(rest.charAt(1) === "i" ? 2 : 1);
		}
	}

	if (rest.startsWith("B")) {
		value *= 8;
		rest = rest.slice(1);
	}

	return { value, rest };
};

export const ffmpegIntegerOf = (name: string, text: string): number => {
	const { value, rest } = avStrtodOf(text);

	if (rest.length > 0) {
		throw new Error(`${name}: "${text}" is not a number`);
	}

	if (value < INT_MIN || value > INT_MAX) {
		throw new Error(`${name}: ${text} is outside [${INT_MIN}, ${INT_MAX}]`);
	}

	if (!Number.isInteger(value)) {
		throw new Error(`${name}: ${text} is not a whole number`);
	}

	return value;
};

export const roundHalfToEven = (value: number): number => {
	const floor = Math.floor(value);
	const difference = value - floor;

	if (difference !== 0.5) {
		return Math.round(value);
	}

	return floor % 2 === 0 ? floor : floor + 1;
};

const signedPrimaryOf = (text: string): { readonly sign: number; readonly primary: string } => {
	const decibels = text.startsWith("-") ? cStrtodOf(text) : undefined;

	if (decibels !== undefined && text.startsWith("dB", decibels.length)) {
		return { sign: 1, primary: text };
	}

	if (text.startsWith("+") || text.startsWith("-")) {
		return { sign: text.startsWith("-") ? -1 : 1, primary: text.slice(1) };
	}

	return { sign: 1, primary: text };
};

export const sampleRateOptionOf = (text: string): number => {
	const { sign, primary } = signedPrimaryOf(text.replace(C_SPACE, ""));
	const constant = Object.hasOwn(SAMPLE_RATE_CONSTANTS, primary) ? SAMPLE_RATE_CONSTANTS[primary] : undefined;
	const parsed = constant === undefined ? avStrtodOf(primary) : { value: constant, rest: "" };
	const value = sign * parsed.value;

	if (primary.length === 0 || parsed.rest.length > 0 || Number.isNaN(value)) {
		throw new Error(`-sample_rate: "${text}" is not a number or default, min or max; arithmetic is not read`);
	}

	if (value < 0 || value > INT_MAX) {
		throw new Error(`-sample_rate: ${text} is outside [0, ${INT_MAX}]`);
	}

	return roundHalfToEven(value);
};

export const cStrtolOf = (text: string): { readonly value: number; readonly length: number } => {
	const match = C_LONG.exec(text);

	if (match === null) {
		return { value: 0, length: 0 };
	}

	const body = match[0].trim();
	const sign = body.startsWith("-") ? -1 : 1;
	const digits = body.replace(/^[+-]/, "");
	const magnitude = /^0[xX]/.test(digits)
		? Number.parseInt(digits.slice(2), 16)
		: /^0[0-7]+$/.test(digits)
			? Number.parseInt(digits.slice(1), 8)
			: Number(digits);

	return { value: sign * magnitude, length: match[0].length };
};
