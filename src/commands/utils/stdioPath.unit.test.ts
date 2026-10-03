import { describe, expect, it } from "vitest";
import { descriptorOf, readableOf, writableOf } from "./stdioPath";

describe("descriptorOf", () => {
	it.each([
		["-", 0, 1],
		["pipe:", 0, 1],
		["pipe:0", 0, 0],
		["pipe: 0", 0, 0],
		["pipe:1", 1, 1],
		["pipe: 1", 1, 1],
		["pipe:+1", 1, 1],
		["pipe:01", 1, 1],
		["pipe:2", 2, 2],
		["pipe:7", 7, 7],
	])("reads %j as descriptor %i as an input and %i as an output", (path, input, output) => {
		expect(descriptorOf(path, "input")).toBe(input);
		expect(descriptorOf(path, "output")).toBe(output);
	});

	it.each(["in.wav", "-x", "./pipe:1", "PIPE:1", "--"])("reads %j as a file path", (path) => {
		expect(descriptorOf(path, "input")).toBeUndefined();
	});

	it.each(["pipe:abc", "pipe:1 ", "pipe: ", "pipe:1a", "pipe:0x1"])("fails %j as a pipe name", (path) => {
		expect(() => descriptorOf(path, "output")).toThrow(
			`Cannot open "${path}": a pipe is pipe: or pipe:<file descriptor>`,
		);
	});

	it("fails a negative descriptor before any stream opens", () => {
		expect(() => descriptorOf("pipe:-1", "input")).toThrow('Cannot open "pipe:-1": a file descriptor is 0 or more');
	});
});

describe("readableOf and writableOf", () => {
	it("give the standard streams for descriptors 0, 1 and 2", () => {
		expect(readableOf(0)).toBe(process.stdin);
		expect(writableOf(1)).toBe(process.stdout);
		expect(writableOf(2)).toBe(process.stderr);
	});
});
