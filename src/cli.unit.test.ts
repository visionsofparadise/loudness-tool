import { describe, expect, it } from "vitest";
import { createProgram } from "./cli";

describe("cli", () => {
	it("names the program loudness-tool", () => {
		expect(createProgram().name()).toBe("loudness-tool");
	});

	it("reports the package version", () => {
		expect(createProgram().version()).toBe("0.1.0");
	});

	it("registers convert", () => {
		expect(createProgram().commands.map((command) => command.name())).toEqual(["convert"]);
	});
});
