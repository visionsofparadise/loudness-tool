import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbToLinear } from "../../utils/db";
import { runCli, writeTestWav } from "../../utils/testCli";
import { createSine } from "../../utils/testSignals";

const SAMPLE_RATE = 48000;

const truePeakOf = async (path: string): Promise<number | null> => {
	const run = await runCli(["stats", "--json", path]);
	const [figures] = JSON.parse(run.stdout.toString("utf8")) as Array<{ truePeakDb: number | null }>;

	return figures?.truePeakDb ?? null;
};

describe("target", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-target-cli-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const writeSine = async (name: string, seconds: number, amplitudeDb: number): Promise<string> => {
		const path = join(workingDirectory, name);

		await writeTestWav(
			path,
			createSine(Math.round(seconds * SAMPLE_RATE), 2, SAMPLE_RATE, 997, dbToLinear(amplitudeDb)),
			{
				bitDepth: "32f",
			},
		);

		return path;
	};

	it("fits only the true peak of a source too short to measure its loudness under --tp alone", async () => {
		const inputPath = await writeSine("short.wav", 0.37, 1.17);
		const outputPath = join(workingDirectory, "short-tp.wav");
		const run = await runCli(["target", inputPath, "-o", outputPath, "--tp", "-1"]);
		const truePeakDb = await truePeakOf(outputPath);

		expect(run.exitCode).toBeUndefined();
		expect(run.stderr).toContain("source has no measurable loudness; fitting true peak only\n");
		expect(truePeakDb ?? Infinity).toBeLessThanOrEqual(-1 + 0.01);
		expect(Math.abs((truePeakDb ?? Infinity) + 1)).toBeLessThan(0.5);
	});

	it("lowers a source too short to measure its loudness to --tp under both targets", async () => {
		const inputPath = await writeSine("short.wav", 0.37, 1.17);
		const outputPath = join(workingDirectory, "short-both.wav");
		const run = await runCli(["target", inputPath, "-o", outputPath, "--lufs", "-16", "--tp", "-1"]);

		expect(run.exitCode).toBeUndefined();
		expect(run.stderr).toBe("source has no measurable loudness; lowered to the true-peak target\n");
		expect((await truePeakOf(outputPath)) ?? Infinity).toBeLessThanOrEqual(-1 + 0.01);
	});

	it("lowers a source too short to measure its loudness to the 0 dBTP ceiling under --lufs alone", async () => {
		const inputPath = await writeSine("short.wav", 0.37, 1.17);
		const outputPath = join(workingDirectory, "short-lufs.wav");
		const run = await runCli(["target", inputPath, "-o", outputPath, "--lufs", "-16"]);
		const truePeakDb = await truePeakOf(outputPath);

		expect(run.exitCode).toBeUndefined();
		expect(run.stderr).toBe("source has no measurable loudness; lowered to the ceiling\n");
		expect(truePeakDb ?? Infinity).toBeLessThanOrEqual(0.01);
		expect(truePeakDb ?? -Infinity).toBeGreaterThan(-0.1);
	});

	it("fails when --floor sits at or above the automatic pivot", async () => {
		const inputPath = await writeSine("quiet.wav", 10, -30);
		const outputPath = join(workingDirectory, "quiet-out.wav");
		const run = await runCli(["target", inputPath, "-o", outputPath, "--lufs", "-16", "--floor", "-20"]);

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toMatch(
			/^error: floor -20 must be below the automatic pivot -(29\.9\d|30\.0\d) LUFS; set --pivot above it\n$/,
		);
		expect(existsSync(outputPath)).toBe(false);
	});

	it.each([
		[["--limit-db", "-10"], "--limit-db"],
		[["--limit-percentile", "0.99"], "--limit-percentile"],
		[["--never-expand"], "--never-expand"],
	])("fails on %j under --lufs alone", async (options, name) => {
		const inputPath = await writeSine("sine.wav", 1, -20);
		const outputPath = join(workingDirectory, "sine-out.wav");
		const run = await runCli(["target", inputPath, "-o", outputPath, "--lufs", "-16", ...options]);

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toBe(`error: ${name} applies only with --tp\n`);
		expect(existsSync(outputPath)).toBe(false);
	});

	it("fails on --never-expand under --tp alone", async () => {
		const inputPath = await writeSine("sine.wav", 1, -20);
		const outputPath = join(workingDirectory, "sine-out.wav");
		const run = await runCli(["target", inputPath, "-o", outputPath, "--tp", "-1", "--never-expand"]);

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toBe("error: --never-expand applies only with --lufs and --tp\n");
		expect(existsSync(outputPath)).toBe(false);
	});
});
