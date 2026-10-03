import { describe, expect, it } from "vitest";
import { ffmpegIntegerOf, sampleRateOptionOf } from "./ffmpegNumber";

describe("ffmpegIntegerOf", () => {
	it.each([
		["48k", 48000],
		["48K", 48000],
		["4.8e4", 48000],
		["4.8e+4", 48000],
		["0xBB80", 48000],
		["0XBB80", 48000],
		["+48000", 48000],
		[" 48000", 48000],
		["0.048M", 48000],
		["1G", 1000000000],
		["1Ki", 1024],
		["48kB", 384000],
		["2.0", 2],
		["2e0", 2],
		["0x2", 2],
		["0dB", 1],
		["60dB", 1000],
		["0dBB", 8],
		["-48000", -48000],
		["", 0],
	])("reads %j as %i, as ffmpeg's parse_number does", (text, value) => {
		expect(ffmpegIntegerOf("-ar", text)).toBe(value);
	});

	it.each(["48k5", "48000abc", "48000 ", "0x", "0x1p3", "abc"])("rejects %j as not a number", (text) => {
		expect(() => ffmpegIntegerOf("-ar", text)).toThrow(`-ar: "${text}" is not a number`);
	});

	it.each(["48000.5", "1.5", "2.5", "6c", "6dB", "20dB", "1m", "1hi", "nan"])(
		"rejects %j as not a whole number",
		(text) => {
			expect(() => ffmpegIntegerOf("-ac:a", text)).toThrow(`-ac:a: ${text} is not a whole number`);
		},
	);

	it.each(["1e10", "2147483648", "-2147483649", "inf", "-inf"])("rejects %j as out of range", (text) => {
		expect(() => ffmpegIntegerOf("-ar", text)).toThrow(`-ar: ${text} is outside [-2147483648, 2147483647]`);
	});
});

describe("sampleRateOptionOf", () => {
	it.each([
		["48000", 48000],
		["48000.4", 48000],
		["48001.5", 48002],
		["48002.5", 48002],
		["20dB", 10],
		["default", 44100],
		["min", 0],
		["max", 2147483647],
		[" 48000 ", 48000],
		["48k", 48000],
	])("reads %j as %i", (text, value) => {
		expect(sampleRateOptionOf(text)).toBe(value);
	});

	it.each(["2*24000", "(48000)", "48000+0", "DEFAULT", "PI", "", "abc"])("rejects %j as an expression", (text) => {
		expect(() => sampleRateOptionOf(text)).toThrow(
			`-sample_rate: "${text}" is not a number or default, min or max; arithmetic is not read`,
		);
	});

	it.each(["-1", "2147483648", "-0.4"])("rejects %j as out of range", (text) => {
		expect(() => sampleRateOptionOf(text)).toThrow(`-sample_rate: ${text} is outside [0, 2147483647]`);
	});
});
