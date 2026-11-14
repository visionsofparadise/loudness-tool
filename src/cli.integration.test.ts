import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSine } from "./utils/testSignals";
import { runCli, writeTestWav } from "./utils/testCli";

describe("target's action errors", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-cli-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it.each([
		[[], "at least one of --lufs and --tp is required"],
		[["--lufs", "-16", "--floor", "-30", "--pivot", "-30"], "floor must be < pivot when both are supplied"],
	])("prints the reason and exits 1 for %j", async (options, message) => {
		const inputPath = join(workingDirectory, "sine.wav");
		const outputPath = join(workingDirectory, "out.wav");

		await writeTestWav(inputPath, createSine(4800, 1, 48000, 997, 0.1), { bitDepth: "16" });

		const run = await runCli(["target", inputPath, "-o", outputPath, ...options]);

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toBe(`error: ${message}\n`);
		expect(run.stdout.length).toBe(0);
		expect(existsSync(outputPath)).toBe(false);
	});
});

describe("an input that overflows the measurement", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-cli-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it.each([[["stats"]], [["tp-norm"]], [["lufs-norm"]], [["target", "--lufs", "-16", "--tp", "-1"]], [["crest"]]])(
		"fails %j naming the input and the frame, writing no output",
		async (command) => {
			const inputPath = join(workingDirectory, "huge.wav");
			const outputPath = join(workingDirectory, "out.wav");
			const channels = createSine(48000, 2, 48000, 997, 0.1);

			channels[1]?.set([1.7e308], 24000);
			await writeTestWav(inputPath, channels, { bitDepth: "64f" });

			const run = await runCli([...command, inputPath, ...(command[0] === "stats" ? [] : ["-o", outputPath])]);

			expect(run.exitCode).toBe(1);
			expect(run.stderr).toBe(`error: "${inputPath}" overflows the measurement at frame 24000
`);
			expect(run.stdout.length).toBe(0);
			expect(existsSync(outputPath)).toBe(false);
		},
	);
});
