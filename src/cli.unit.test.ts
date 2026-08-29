import { describe, expect, it, vi } from "vitest";
import { createProgram, runProgram } from "./cli";

describe("cli", () => {
	it("names the program loudness-tool", () => {
		expect(createProgram().name()).toBe("loudness-tool");
	});

	it("reports the package version", () => {
		expect(createProgram().version()).toBe("0.1.0");
	});

	it("registers stats, tp-norm, lufs-norm, target, and crest", () => {
		expect(createProgram().commands.map((command) => command.name())).toEqual([
			"stats",
			"tp-norm",
			"lufs-norm",
			"target",
			"crest",
		]);
	});

	it("prints extra-argument failures as one-line errors", async () => {
		const writes: Array<string> = [];
		const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			writes.push(String(chunk));

			return true;
		});
		const previousExitCode = process.exitCode;

		process.exitCode = undefined;

		try {
			await runProgram(["node", "loudness-tool", "convert"]);

			expect(process.exitCode).toBe(1);
			expect(writes.join("")).toMatch(/^error: /);
		} finally {
			write.mockRestore();
			process.exitCode = previousExitCode;
		}
	});
});
