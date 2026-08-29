import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linearToDb } from "../utils/db";
import { createSine } from "../utils/testSignals";
import { WavWriter } from "../wav/WavWriter";
import { stats } from "./stats";

const SAMPLE_RATE = 48000;

const writeWav = async (path: string, channels: Array<Float64Array>, bitDepth: "16" | "32f" = "32f"): Promise<void> => {
	const writer = await WavWriter.create(path, {
		sampleRate: SAMPLE_RATE,
		channelCount: channels.length,
		bitDepth,
	});

	await writer.write(channels);
	await writer.close();
};

const capture = async (
	run: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> => {
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	const writeOut = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout.push(String(chunk));

		return true;
	});
	const writeErr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr.push(String(chunk));

		return true;
	});
	const previousExitCode = process.exitCode;

	process.exitCode = undefined;

	try {
		await run();

		return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode };
	} finally {
		writeOut.mockRestore();
		writeErr.mockRestore();
		process.exitCode = previousExitCode;
	}
};

describe("stats", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-stats-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("prints aligned human-readable lines for a single file", async () => {
		const inputPath = join(workingDirectory, "sine.wav");
		const frameCount = 4800;
		const channels = createSine(frameCount, 1, SAMPLE_RATE, 997, 0.5);

		await writeWav(inputPath, channels);

		const { stdout, stderr, exitCode } = await capture(() => stats([inputPath], {}));

		expect(exitCode).toBeUndefined();
		expect(stderr).toBe("");
		expect(stdout).toContain(inputPath);
		expect(stdout).toMatch(/sample rate\s+48000 Hz/);
		expect(stdout).toMatch(/channels\s+1/);
		expect(stdout).toMatch(/bit depth\s+32f/);
		expect(stdout).toMatch(/duration\s+0\.100 s/);
		expect(stdout).toMatch(/true peak\s+-?\d/);
		expect(stdout).toMatch(/integrated\s+n\/a/);
		expect(stdout).toMatch(/loudness range\s+n\/a/);
	});

	it("prints one group per file for multiple inputs", async () => {
		const firstPath = join(workingDirectory, "first.wav");
		const secondPath = join(workingDirectory, "second.wav");

		await writeWav(firstPath, createSine(480, 1, SAMPLE_RATE, 440, 0.5));
		await writeWav(secondPath, createSine(960, 2, SAMPLE_RATE, 220, 0.25), "16");

		const { stdout, exitCode } = await capture(() => stats([firstPath, secondPath], {}));

		expect(exitCode).toBeUndefined();
		expect(stdout.indexOf(firstPath)).toBeGreaterThanOrEqual(0);
		expect(stdout.indexOf(secondPath)).toBeGreaterThan(stdout.indexOf(firstPath));
		expect(stdout).toMatch(/channels\s+1/);
		expect(stdout).toMatch(/channels\s+2/);
		expect(stdout).toMatch(/bit depth\s+16/);
	});

	it("prints a JSON array with pinned key names and nothing else", async () => {
		const inputPath = join(workingDirectory, "json.wav");
		const frameCount = 480;

		await writeWav(inputPath, createSine(frameCount, 2, SAMPLE_RATE, 997, 0.5));

		const { stdout, stderr, exitCode } = await capture(() => stats([inputPath], { json: true }));
		const parsed: unknown = JSON.parse(stdout);

		expect(exitCode).toBeUndefined();
		expect(stderr).toBe("");
		expect(stdout.trim()).toBe(JSON.stringify(parsed));
		expect(Array.isArray(parsed)).toBe(true);

		const [entry] = parsed as Array<Record<string, unknown>>;

		expect(Object.keys(entry ?? {}).slice(0, 6)).toEqual([
			"path",
			"sampleRate",
			"channelCount",
			"bitDepth",
			"durationSeconds",
			"truePeakDb",
		]);
		expect(Object.keys(entry ?? {}).slice(0, 7)).toEqual([
			"path",
			"sampleRate",
			"channelCount",
			"bitDepth",
			"durationSeconds",
			"truePeakDb",
			"integratedLufs",
		]);
		expect(Object.keys(entry ?? {})).toEqual([
			"path",
			"sampleRate",
			"channelCount",
			"bitDepth",
			"durationSeconds",
			"truePeakDb",
			"integratedLufs",
			"loudnessRange",
		]);
		expect(entry?.path).toBe(inputPath);
		expect(entry?.sampleRate).toBe(SAMPLE_RATE);
		expect(entry?.channelCount).toBe(2);
		expect(entry?.bitDepth).toBe("32f");
		expect(entry?.durationSeconds).toBe(frameCount / SAMPLE_RATE);
		expect(typeof entry?.truePeakDb).toBe("number");
		expect(entry?.integratedLufs).toBeNull();
		expect(entry?.loudnessRange).toBeNull();
	});

	it("reports truePeakDb null and human n/a for a zero-frame file", async () => {
		const inputPath = join(workingDirectory, "empty.wav");
		const writer = await WavWriter.create(inputPath, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "32f",
		});

		await writer.close();

		const human = await capture(() => stats([inputPath], {}));

		expect(human.exitCode).toBeUndefined();
		expect(human.stdout).toMatch(/true peak\s+n\/a/);
		expect(human.stdout).toMatch(/integrated\s+n\/a/);
		expect(human.stdout).toMatch(/loudness range\s+n\/a/);

		const json = await capture(() => stats([inputPath], { json: true }));
		const parsed = JSON.parse(json.stdout) as Array<{
			truePeakDb: number | null;
			integratedLufs: number | null;
			loudnessRange: number | null;
			durationSeconds: number;
		}>;

		expect(parsed[0]?.truePeakDb).toBeNull();
		expect(parsed[0]?.integratedLufs).toBeNull();
		expect(parsed[0]?.loudnessRange).toBeNull();
		expect(parsed[0]?.durationSeconds).toBe(0);
	});

	it("reports a sine within 0.01 dB of its analytic dBTP", async () => {
		const inputPath = join(workingDirectory, "analytic.wav");
		const amplitude = 0.5;
		const analyticDb = linearToDb(amplitude);

		await writeWav(inputPath, createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, amplitude));

		const { stdout } = await capture(() => stats([inputPath], { json: true }));
		const parsed = JSON.parse(stdout) as Array<{ truePeakDb: number | null }>;

		expect(parsed[0]?.truePeakDb).toEqual(expect.any(Number));
		expect(Math.abs((parsed[0]?.truePeakDb ?? 0) - analyticDb)).toBeLessThan(0.01);
	});

	it("reports a full-scale 997 Hz sine within 0.05 LU of -3.01 LUFS", async () => {
		const inputPath = join(workingDirectory, "full-scale.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE * 5, 1, SAMPLE_RATE, 997, 1));

		const { stdout } = await capture(() => stats([inputPath], { json: true }));
		const parsed = JSON.parse(stdout) as Array<{ integratedLufs: number | null; loudnessRange: number | null }>;

		expect(parsed[0]?.integratedLufs).toEqual(expect.any(Number));
		expect(Math.abs((parsed[0]?.integratedLufs ?? 0) - -3.01)).toBeLessThanOrEqual(0.05);
		expect(parsed[0]?.loudnessRange).toEqual(expect.any(Number));
	});

	it("reports loudnessRange 0 for silence long enough to close short-term windows", async () => {
		const inputPath = join(workingDirectory, "silence.wav");
		const writer = await WavWriter.create(inputPath, {
			sampleRate: SAMPLE_RATE,
			channelCount: 1,
			bitDepth: "32f",
		});

		await writer.write([new Float64Array(SAMPLE_RATE * 4)]);
		await writer.close();

		const human = await capture(() => stats([inputPath], {}));
		const json = await capture(() => stats([inputPath], { json: true }));
		const parsed = JSON.parse(json.stdout) as Array<{ loudnessRange: number | null }>;

		expect(human.stdout).toMatch(/loudness range\s+0\.00 LU/);
		expect(parsed[0]?.loudnessRange).toBe(0);
	});

	it("errors naming an unreadable file, measures the rest, and exits non-zero", async () => {
		const firstPath = join(workingDirectory, "first.wav");
		const missingPath = join(workingDirectory, "missing.wav");
		const unreadablePath = join(workingDirectory, "not-a-wav.txt");
		const lastPath = join(workingDirectory, "last.wav");

		await writeWav(firstPath, createSine(240, 1, SAMPLE_RATE, 440, 0.4));
		await writeFile(unreadablePath, "not a wav");
		await writeWav(lastPath, createSine(240, 1, SAMPLE_RATE, 440, 0.2));

		const { stdout, stderr, exitCode } = await capture(() =>
			stats([firstPath, missingPath, unreadablePath, lastPath], { json: true }),
		);
		const parsed = JSON.parse(stdout) as Array<{ path: string }>;

		expect(exitCode).toBe(1);
		expect(stderr).toMatch(/^error: /m);
		expect(stderr).toContain(missingPath);
		expect(stderr).toContain(unreadablePath);
		expect(parsed.map((entry) => entry.path)).toEqual([firstPath, lastPath]);
	});
});
