import { describe, expect, it, vi } from "vitest";
import { AudioProgram, streamScopesOf } from "./AudioProgram";
import { DEFAULT_STREAM_OPTIONS } from "./streamOptions";
import type { Command } from "commander";

describe("AudioProgram", () => {
	it("records the parsed command's stream scopes and writes the warnings to stderr", async () => {
		const program = new AudioProgram();
		const operands: Array<string> = [];
		let parsed: Command | undefined;
		const stub = program
			.command("stub")
			.argument("<inputs...>")
			.requiredOption("-o, --output <path>")
			.action((inputs: Array<string>, _options: unknown, command: Command) => {
				operands.push(...inputs);
				parsed = command;
			});
		const writes: Array<string> = [];
		const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			writes.push(String(chunk));

			return true;
		});

		try {
			await program.parseAsync(
				["stub", "-f", "s16le", "-ar", "48000", "a.raw", "b.wav", "-ar:v", "1", "-o", "-", "-ac", "2"],
				{ from: "user" },
			);
		} finally {
			write.mockRestore();
		}

		expect(parsed).toBe(stub);
		expect(operands).toEqual(["a.raw", "b.wav"]);
		expect(streamScopesOf(stub)).toEqual({
			inputs: [
				{ ...DEFAULT_STREAM_OPTIONS, format: "s16le", sampleRate: 48000, sampleRateOption: "-ar" },
				DEFAULT_STREAM_OPTIONS,
			],
			output: DEFAULT_STREAM_OPTIONS,
		});
		expect(writes).toEqual([
			"warning: -ar:v 1 selects no output stream and is ignored\n",
			"warning: -ac 2 follows the last file and is ignored\n",
		]);
	});

	it("gives a command parsed without scopes no inputs and the default output", () => {
		const program = new AudioProgram();

		expect(streamScopesOf(program.command("other"))).toEqual({ inputs: [], output: DEFAULT_STREAM_OPTIONS });
	});
});
