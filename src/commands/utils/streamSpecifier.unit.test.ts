import { describe, expect, it } from "vitest";
import { selectsStream, streamSpecifierOf } from "./streamSpecifier";

const selectionOf = (specifier: string, isUsable: boolean): boolean | undefined => {
	const parsed = streamSpecifierOf(specifier);

	return parsed === undefined ? undefined : selectsStream(parsed, isUsable);
};

describe("streamSpecifierOf and selectsStream", () => {
	it.each([
		["disp:0", true],
		["disp:none", true],
		["disp:0x0", true],
		["disp:0k", true],
		["disp:0:disp:0", true],
		["a:disp:0", true],
		["disp:1", false],
		["disp:+default", false],
		["disp:++default", false],
		["disp:default++dub", false],
		["disp:all", false],
		["disp:1e0", false],
		["disp:0+PI", false],
		["disp:0:disp:1", false],
		["m:x:", false],
		["m:", false],
		["m:'a:b'", false],
	])("reads %j as ffmpeg 8.0 does, selecting the output's stream: %s", (specifier, selects) => {
		expect(selectionOf(specifier, false)).toBe(selects);
	});

	it.each([
		"disp:1:disp:0",
		"disp:PI",
		"disp:E",
		"disp:DEFAULT",
		"disp:nan",
		"disp:",
		"disp:default+",
		"disp:+",
		"disp:4294967296",
		"disp:0.5",
		"m:x:y:z",
		"m:x:y:",
	])("fails %j as ffmpeg 8.0 does", (specifier) => {
		expect(streamSpecifierOf(specifier)).toBeUndefined();
	});

	it("selects an input's stream with u, whose parameters its demuxer has filled, and not the output's", () => {
		expect(selectionOf("u", true)).toBe(true);
		expect(selectionOf("a:u", true)).toBe(true);
		expect(selectionOf("u", false)).toBe(false);
		expect(selectionOf("disp:default", true)).toBe(false);
		expect(selectionOf("1", true)).toBe(false);
		expect(selectionOf("#0", true)).toBe(true);
	});
});
