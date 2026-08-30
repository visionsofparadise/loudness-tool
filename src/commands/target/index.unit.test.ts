import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../cli";
import { IntegratedLufsAccumulator } from "../../measurement/IntegratedLufsAccumulator";
import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { dbToLinear, linearToDb } from "../../utils/db";
import { createSine } from "../../utils/testSignals";
import { WavWriter } from "../../wav/WavWriter";
import { pushWavBlocks, withWavReader } from "../utils/withWavReader";
import { target } from "./index";

const SAMPLE_RATE = 48000;

const writeWav = async (path: string, channels: Array<Float64Array>): Promise<void> => {
	const writer = await WavWriter.create(path, {
		sampleRate: SAMPLE_RATE,
		channelCount: channels.length,
		bitDepth: "32f",
	});

	await writer.write(channels);
	await writer.close();
};

const makeCrossAxis = (seconds: number): Float64Array => {
	const frameCount = SAMPLE_RATE * seconds;
	const channel = new Float64Array(frameCount);
	const bed = dbToLinear(-30);
	const impulse = dbToLinear(-3);
	const period = Math.round(SAMPLE_RATE / 8);
	const impulseStart = SAMPLE_RATE;
	const impulseEnd = SAMPLE_RATE * 2;

	for (let index = 0; index < frameCount; index++) {
		const sine = bed * Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE);

		channel[index] = index >= impulseStart && index < impulseEnd && index % period === 0 ? impulse : sine;
	}

	return channel;
};

const measureFile = async (path: string): Promise<{ integratedLufs: number; truePeakDb: number }> =>
	withWavReader(path, async (reader) => {
		const lufs = new IntegratedLufsAccumulator(reader.format.sampleRate, reader.format.channelCount);
		const truePeak = new TruePeakAccumulator(reader.format.channelCount);

		await pushWavBlocks(reader, [lufs, truePeak]);

		return {
			integratedLufs: lufs.finalize(),
			truePeakDb: linearToDb(truePeak.finalize()),
		};
	});

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

const parseProgram = (argv: Array<string>) => {
	const program = createProgram();
	const silence = {
		writeOut: () => undefined,
		writeErr: () => undefined,
	};

	program.exitOverride();
	program.configureOutput(silence);

	for (const command of program.commands) {
		command.exitOverride();
		command.configureOutput(silence);
	}

	return program.parseAsync(argv, { from: "user" });
};

describe("target", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-target-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("rejects out-of-range flags", async () => {
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--lufs", "-51"])).rejects.toThrow(
			/lufs must be in \[-50, 0\]/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--lufs", "0.1"])).rejects.toThrow(
			/lufs must be in \[-50, 0\]/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--tp", "0"])).rejects.toThrow(
			/tp must be in \[-24, 0\)/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--pivot", "1"])).rejects.toThrow(
			/pivot must be in \[-80, 0\)/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--floor", "0"])).rejects.toThrow(
			/floor must be in \[-100, 0\)/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--limit-percentile", "0.4"])).rejects.toThrow(
			/limit-percentile must be in \[0.5, 1.0\]/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--limit-db", "0"])).rejects.toThrow(
			/limit-db must be in \[-60, 0\)/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--smoothing", "0"])).rejects.toThrow(
			/smoothing must be in \[0.01, 200\]/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--tolerance", "0"])).rejects.toThrow(
			/tolerance must be > 0/,
		);
	});

	it("rejects each donor bound at the CLI parser and the exported function", async () => {
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--tp", "-400"])).rejects.toThrow(
			/tp must be in \[-24, 0\), received -400/,
		);
		await expect(target("in.wav", { output: "out.wav", tp: -400 })).rejects.toThrow(
			"tp must be in [-24, 0), received -400",
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--pivot", "-90"])).rejects.toThrow(
			/pivot must be in \[-80, 0\), received -90/,
		);
		await expect(target("in.wav", { output: "out.wav", pivot: -90 })).rejects.toThrow(
			"pivot must be in [-80, 0), received -90",
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--floor", "-101"])).rejects.toThrow(
			/floor must be in \[-100, 0\), received -101/,
		);
		await expect(target("in.wav", { output: "out.wav", floor: -101 })).rejects.toThrow(
			"floor must be in [-100, 0), received -101",
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--limit-db", "-61"])).rejects.toThrow(
			/limit-db must be in \[-60, 0\), received -61/,
		);
		await expect(target("in.wav", { output: "out.wav", limitDb: -61 })).rejects.toThrow(
			"limit-db must be in [-60, 0), received -61",
		);
	});

	it("accepts each donor lower edge", async () => {
		const inputPath = join(workingDirectory, "bound-silent.wav");
		const cliOutputPath = join(workingDirectory, "bound-silent-cli.wav");
		const functionOutputPath = join(workingDirectory, "bound-silent-fn.wav");

		await writeWav(inputPath, [new Float64Array(64)]);

		const cli = await capture(async () => {
			await parseProgram([
				"target",
				inputPath,
				"-o",
				cliOutputPath,
				"--tp",
				"-24",
				"--pivot",
				"-80",
				"--floor",
				"-100",
				"--limit-db",
				"-60",
			]);
		});
		const direct = await capture(() =>
			target(inputPath, {
				output: functionOutputPath,
				tp: -24,
				pivot: -80,
				floor: -100,
				limitDb: -60,
			}),
		);

		expect(cli.exitCode).toBeUndefined();
		expect(direct.exitCode).toBeUndefined();
		expect(cli.stderr).toMatch(/no measurable loudness/);
		expect(direct.stderr).toMatch(/no measurable loudness/);
	});

	it("rejects floor >= pivot when both are supplied", async () => {
		await expect(
			parseProgram(["target", "in.wav", "-o", "out.wav", "--floor", "-10", "--pivot", "-20"]),
		).rejects.toThrow(/floor must be < pivot/);
	});

	it("fits a cross-axis fixture inside the never-exceed box", async () => {
		const inputPath = join(workingDirectory, "crossaxis.wav");
		const outputPath = join(workingDirectory, "crossaxis-out.wav");
		const scratchDir = join(workingDirectory, "scratch");

		await writeWav(inputPath, [makeCrossAxis(3)]);

		const { stdout, stderr, exitCode } = await capture(() =>
			target(inputPath, {
				output: outputPath,
				lufs: -20,
				tp: -6,
				scratchDir,
			}),
		);
		const measured = await measureFile(outputPath);

		expect(exitCode).toBeUndefined();
		expect(stderr).toMatch(/attempt 1/);
		expect(stdout).toMatch(/output integrated/);
		expect(stdout).toMatch(/converged/);
		expect(measured.integratedLufs).toBeLessThanOrEqual(-20 + 0.01);
		expect(measured.truePeakDb).toBeLessThanOrEqual(-6 + 0.01);
		expect(await readdir(scratchDir)).toEqual([]);
	}, 30_000);

	it("rejects a 4-channel source", async () => {
		const inputPath = join(workingDirectory, "quad.wav");
		const outputPath = join(workingDirectory, "quad-out.wav");

		await writeWav(inputPath, createSine(64, 4, SAMPLE_RATE, 440, 0.5));

		await expect(target(inputPath, { output: outputPath, lufs: -16 })).rejects.toThrow(
			`${inputPath}: 4 channels unsupported; loudness measurement beyond stereo needs BS.1770 Table 3 channel weighting`,
		);
	});

	it("copies an unmeasurable source byte-identically", async () => {
		const inputPath = join(workingDirectory, "silence.wav");
		const outputPath = join(workingDirectory, "silence-out.wav");

		await writeWav(inputPath, [new Float64Array(SAMPLE_RATE)]);

		const { stdout, stderr, exitCode } = await capture(() => target(inputPath, { output: outputPath, lufs: -16 }));

		expect(exitCode).toBeUndefined();
		expect(stdout).toBe("");
		expect(stderr).toMatch(/no measurable loudness/);
		expect(Buffer.compare(await readFile(inputPath), await readFile(outputPath))).toBe(0);
	});

	it("supports in-place -o <input>", async () => {
		const inputPath = join(workingDirectory, "inplace.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE * 2, 1, SAMPLE_RATE, 997, dbToLinear(-20)));
		await capture(() => target(inputPath, { output: inputPath, lufs: -16 }));

		const measured = await measureFile(inputPath);

		expect(measured.integratedLufs).toBeLessThanOrEqual(-16 + 0.5);
		expect(existsSync(inputPath)).toBe(true);
	}, 30_000);

	it("cleans scratch on an injected write failure", async () => {
		const inputPath = join(workingDirectory, "fail.wav");
		const scratchDir = join(workingDirectory, "scratch-fail");
		const outputPath = join(workingDirectory, "missing", "out.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-20)));
		await mkdir(scratchDir, { recursive: true });

		await expect(capture(() => target(inputPath, { output: outputPath, lufs: -16, scratchDir }))).rejects.toThrow();

		expect(await readdir(scratchDir)).toEqual([]);
	});
});
