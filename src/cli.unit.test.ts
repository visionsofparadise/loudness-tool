import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createProgram, runProgram } from "./cli";
import { captureWrites, runCli } from "./utils/testCli";
import { createSine } from "./utils/testSignals";
import { WavWriter } from "./wav/WavWriter";

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

	it("reads --scratch-dir as a program option before or after the subcommand", async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-cli-"));

		try {
			const inputPath = join(workingDirectory, "input.wav");
			const writer = await WavWriter.create(
				{ kind: "file", path: inputPath },
				{ sampleRate: 48000, channelCount: 1, channelMask: 0, bitDepth: "16", frameCount: 4800 },
			);

			await writer.write(createSine(4800, 1, 48000, 997, 0.5));
			await writer.close();

			const input = await readFile(inputPath);
			const before = join(workingDirectory, "before");
			const after = join(workingDirectory, "after");
			const beforeRun = await runCli(["--scratch-dir", before, "tp-norm", "-", "-o", "-"], input);
			const afterRun = await runCli(["tp-norm", "-", "-o", "-", "--scratch-dir", after], input);

			expect([beforeRun.exitCode, afterRun.exitCode]).toEqual([undefined, undefined]);
			expect(afterRun.stdout.equals(beforeRun.stdout)).toBe(true);
			expect(await readdir(before)).toEqual([]);
			expect(await readdir(after)).toEqual([]);
			expect(createProgram().options.map((option) => option.long)).toContain("--scratch-dir");
			expect(
				createProgram()
					.commands.flatMap((command) => command.options)
					.map((option) => option.long),
			).not.toContain("--scratch-dir");
		} finally {
			await rm(workingDirectory, { recursive: true, force: true });
		}
	});

	it("reports a stdin input's read errors as a file input's, with - as its path, on every command", async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-cli-"));

		try {
			const validPath = join(workingDirectory, "valid.wav");
			const writer = await WavWriter.create(
				{ kind: "file", path: validPath },
				{ sampleRate: 48000, channelCount: 1, channelMask: 0, bitDepth: "16", frameCount: 480 },
			);

			await writer.write(createSine(480, 1, 48000, 997, 0.5));
			await writer.close();

			const valid = await readFile(validPath);
			const zeroChannels = Buffer.from(valid);

			zeroChannels.writeUInt16LE(0, 22);

			const inputs = [
				Buffer.alloc(0),
				Buffer.from("not a wav file at all"),
				valid.subarray(0, 30),
				valid.subarray(0, 36),
				zeroChannels,
			];
			const inputPath = join(workingDirectory, "input.wav");
			const outputPath = join(workingDirectory, "output.wav");
			const commands = [
				["stats"],
				["tp-norm", "-o", outputPath],
				["lufs-norm", "-o", outputPath],
				["crest", "-o", outputPath],
				["target", "-o", outputPath, "--lufs", "-16"],
			];

			for (const input of inputs) {
				await writeFile(inputPath, input);

				for (const [name = "", ...options] of commands) {
					const fileRun = await runCli([name, inputPath, ...options]);
					const stdinRun = await runCli([name, "-", ...options], input);

					expect(fileRun.exitCode).toBe(1);
					expect(stdinRun.exitCode).toBe(1);
					expect(stdinRun.stderr).toBe(fileRun.stderr.replaceAll(inputPath, "-"));
				}
			}
		} finally {
			await rm(workingDirectory, { recursive: true, force: true });
		}
	});

	it("ends a broken stdout as one error line and exit code 1 on every command", async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-cli-"));
		const stderr: Array<string> = [];
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(captureWrites((chunk) => stderr.push(chunk.toString("utf8"))));
		const previousExitCode = process.exitCode;

		try {
			const inputPath = join(workingDirectory, "input.wav");
			const outputPath = join(workingDirectory, "output.wav");
			const writer = await WavWriter.create(
				{ kind: "file", path: inputPath },
				{ sampleRate: 48000, channelCount: 1, channelMask: 0, bitDepth: "16", frameCount: 48000 },
			);

			await writer.write(createSine(48000, 1, 48000, 997, 0.5));
			await writer.close();

			const commands = [
				["stats", inputPath, inputPath],
				["stats", inputPath, "--json"],
				...[outputPath, "-"].flatMap((output) => [
					["tp-norm", inputPath, "-o", output],
					["lufs-norm", inputPath, "-o", output],
					["crest", inputPath, "-o", output],
					["target", inputPath, "-o", output, "--lufs", "-16"],
				]),
			];

			for (const command of commands) {
				const brokenStdout = new Writable({
					write: (_chunk, _encoding, callback) => {
						callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
					},
				});
				const stdoutSpy = vi
					.spyOn(process, "stdout", "get")
					.mockReturnValue(brokenStdout as unknown as typeof process.stdout);

				stderr.length = 0;
				process.exitCode = undefined;

				try {
					await runProgram(["node", "loudness-tool", ...command]);
				} finally {
					stdoutSpy.mockRestore();
				}

				expect({ command, exitCode: process.exitCode, stderr: stderr.join("") }).toEqual({
					command,
					exitCode: 1,
					stderr: expect.stringMatching(/(?:^|\n)error: write EPIPE\n$/),
				});
			}
		} finally {
			stderrSpy.mockRestore();
			process.exitCode = previousExitCode;
			await rm(workingDirectory, { recursive: true, force: true });
		}
	});

	it("shows - for stdin and stdout and the program's --scratch-dir in every command's help", () => {
		for (const command of createProgram().commands) {
			const help = command.helpInformation();

			expect(help).toContain("- for stdin");
			expect(help).toContain("--scratch-dir <path>");

			if (command.name() !== "stats") {
				expect(help).toContain("output WAV path, or - for stdout");
			}
		}
	});
});
