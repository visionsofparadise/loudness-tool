import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli";
import { dbToLinear, linearToDb } from "../utils/db";
import {
	captureWrites,
	dataBytesOf,
	expectRawMatchesFileMode,
	runCli,
	runSilenceOnStdin,
	runStdioCombinations,
	writeTestWav,
} from "../utils/testCli";
import { createNoise, createSine } from "../utils/testSignals";
import { WavReader, type AudioBlock } from "../wav/WavReader";
import { writeExtensibleWav } from "../utils/testWav";
import { WavStreamReader } from "../wav/WavStreamReader";
import { WavWriter } from "../wav/WavWriter";
import { lufsNorm } from "./lufsNorm";

const SAMPLE_RATE = 48000;
const PRE_B0 = 1.53512485958697;
const PRE_B1 = -2.69169618940638;
const PRE_B2 = 1.19839281085285;
const PRE_A1 = -1.69065929318241;
const PRE_A2 = 0.73248077421585;
const RLB_B0 = 1.0;
const RLB_B1 = -2.0;
const RLB_B2 = 1.0;
const RLB_A1 = -1.99004745483398;
const RLB_A2 = 0.99007225036621;
const LUFS_OFFSET = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_OFFSET_LU = -10;
const BLOCK_DURATION_SECONDS = 0.4;
const BLOCK_STEP_SECONDS = 0.1;

const applyBiquad = (input: Float64Array, b0: number, b1: number, b2: number, a1: number, a2: number): Float64Array => {
	const output = new Float64Array(input.length);
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;

	for (let index = 0; index < input.length; index++) {
		const x0 = input[index] ?? 0;
		const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;

		output[index] = y0;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
	}

	return output;
};

const measureIndependent = (channels: ReadonlyArray<Float64Array>, sampleRate: number): number => {
	const frameCount = channels[0]?.length ?? 0;
	const weighted = new Float64Array(frameCount);

	weighted.fill(-0);

	for (const channel of channels) {
		const preFiltered = applyBiquad(channel, PRE_B0, PRE_B1, PRE_B2, PRE_A1, PRE_A2);
		const rlbFiltered = applyBiquad(preFiltered, RLB_B0, RLB_B1, RLB_B2, RLB_A1, RLB_A2);

		for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
			const sample = rlbFiltered[frameIndex] ?? 0;

			weighted[frameIndex] = (weighted[frameIndex] ?? 0) + sample * sample;
		}
	}

	const blockSize = Math.round(BLOCK_DURATION_SECONDS * sampleRate);
	const blockStep = Math.round(BLOCK_STEP_SECONDS * sampleRate);
	const blockCount = frameCount < blockSize ? 0 : Math.floor((frameCount - blockSize) / blockStep) + 1;
	const blockSums = new Float64Array(blockCount);

	for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
		const start = blockIndex * blockStep;
		let sum = 0;

		for (let index = 0; index < blockSize; index++) {
			sum += weighted[start + index] ?? 0;
		}

		blockSums[blockIndex] = sum;
	}

	if (blockCount === 0) {
		return -Infinity;
	}

	const absoluteThresholdPower = Math.pow(10, (ABSOLUTE_GATE_LUFS - LUFS_OFFSET) / 10);
	let absoluteSurvivorCount = 0;
	let absoluteSum = 0;

	for (const blockSum of blockSums) {
		const power = blockSum / blockSize;

		if (power > absoluteThresholdPower) {
			absoluteSum += power;
			absoluteSurvivorCount++;
		}
	}

	if (absoluteSurvivorCount === 0) {
		return -Infinity;
	}

	const relativeThresholdPower = Math.pow(
		10,
		(LUFS_OFFSET + 10 * Math.log10(absoluteSum / absoluteSurvivorCount) + RELATIVE_GATE_OFFSET_LU - LUFS_OFFSET) / 10,
	);
	let relativeSurvivorCount = 0;
	let relativeSum = 0;

	for (const blockSum of blockSums) {
		const power = blockSum / blockSize;

		if (power > absoluteThresholdPower && power > relativeThresholdPower) {
			relativeSum += power;
			relativeSurvivorCount++;
		}
	}

	if (relativeSurvivorCount === 0) {
		return -Infinity;
	}

	return LUFS_OFFSET + 10 * Math.log10(relativeSum / relativeSurvivorCount);
};

const mergeBlocks = (blocks: Array<AudioBlock>): Array<Float64Array> => {
	const channelCount = blocks[0]?.channels.length ?? 0;
	const frameCount = blocks.reduce((total, block) => total + (block.channels[0]?.length ?? 0), 0);
	const merged: Array<Float64Array> = [];

	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		merged.push(new Float64Array(frameCount));
	}

	let cursor = 0;

	for (const block of blocks) {
		const blockFrames = block.channels[0]?.length ?? 0;

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			merged[channelIndex]?.set(block.channels[channelIndex] ?? new Float64Array(blockFrames), cursor);
		}

		cursor += blockFrames;
	}

	return merged;
};

const readAll = async (path: string): Promise<Array<Float64Array>> => {
	const reader = await WavReader.open(path);
	const blocks: Array<AudioBlock> = [];

	for await (const block of reader.blocks()) {
		blocks.push(block);
	}

	await reader.close();

	return mergeBlocks(blocks);
};

const writeWav = async (path: string, channels: Array<Float64Array>): Promise<void> => {
	const writer = await WavWriter.create(
		{ kind: "file", path },
		{
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			channelMask: 0,
			bitDepth: "32f",
			frameCount: channels[0]?.length ?? 0,
		},
	);

	await writer.write(channels);
	await writer.close();
};

const measureFileIndependent = async (path: string): Promise<number> =>
	measureIndependent(await readAll(path), SAMPLE_RATE);

const capture = async (
	run: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> => {
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	const writeOut = vi
		.spyOn(process.stdout, "write")
		.mockImplementation(captureWrites((chunk) => stdout.push(chunk.toString("utf8"))));
	const writeErr = vi
		.spyOn(process.stderr, "write")
		.mockImplementation(captureWrites((chunk) => stderr.push(chunk.toString("utf8"))));
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

const temporaryNamesOf = async (directory: string): Promise<Array<string>> => {
	const names = await readdir(directory);

	return names.filter((name) => name.endsWith(".tmp"));
};

describe("lufs-norm", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-lufs-norm-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("lands a -20 dBFS sine at -16 LUFS within 0.1 LU", async () => {
		const inputPath = join(workingDirectory, "minus20.wav");
		const outputPath = join(workingDirectory, "minus20-at16.wav");
		const target = -16;

		await writeWav(inputPath, createSine(SAMPLE_RATE * 3, 1, SAMPLE_RATE, 997, dbToLinear(-20)));

		const { stdout, stderr, exitCode } = await capture(() =>
			lufsNorm(inputPath, { output: outputPath, lufs: target }),
		);
		const measured = await measureFileIndependent(outputPath);

		expect(exitCode).toBeUndefined();
		expect(stderr).toBe("");
		expect(Math.abs(measured - target)).toBeLessThan(0.1);
		expect(stdout).toMatch(/source integrated/);
		expect(stdout).toMatch(/target\s+-16\.00 LUFS/);
		expect(stdout).toMatch(/output true peak\s+-?\d+\.\d+ dBTP/);
		expect(stdout).toContain(outputPath);
	});

	it("copies an unmeasurable source byte-identically and exits 0", async () => {
		const inputPath = join(workingDirectory, "silence.wav");
		const outputPath = join(workingDirectory, "silence-out.wav");

		await writeWav(inputPath, [new Float64Array(SAMPLE_RATE * 2)]);

		const { stdout, stderr, exitCode } = await capture(() => lufsNorm(inputPath, { output: outputPath, lufs: -16 }));
		const inputBytes = await readFile(inputPath);
		const outputBytes = await readFile(outputPath);

		expect(exitCode).toBeUndefined();
		expect(stdout).toBe("");
		expect(stderr).toMatch(/no measurable loudness/);
		expect(Buffer.compare(inputBytes, outputBytes)).toBe(0);
	});

	it("copies a sub-block source byte-identically", async () => {
		const inputPath = join(workingDirectory, "short.wav");
		const outputPath = join(workingDirectory, "short-out.wav");

		await writeWav(inputPath, createSine(64, 1, SAMPLE_RATE, 997, 1));

		const { stderr, exitCode } = await capture(() => lufsNorm(inputPath, { output: outputPath, lufs: -16 }));

		expect(exitCode).toBeUndefined();
		expect(stderr).toMatch(/no measurable loudness/);
		expect(Buffer.compare(await readFile(inputPath), await readFile(outputPath))).toBe(0);
	});

	it("supports in-place -o <input>", async () => {
		const inputPath = join(workingDirectory, "inplace.wav");
		const target = -16;

		await writeWav(inputPath, createSine(SAMPLE_RATE * 3, 1, SAMPLE_RATE, 997, dbToLinear(-20)));
		await capture(() => lufsNorm(inputPath, { output: inputPath, lufs: target }));

		expect(Math.abs((await measureFileIndependent(inputPath)) - target)).toBeLessThan(0.1);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("skips the write for in-place unmeasurable input", async () => {
		const inputPath = join(workingDirectory, "inplace-silence.wav");

		await writeWav(inputPath, [new Float64Array(SAMPLE_RATE)]);

		const original = await readFile(inputPath);
		const { stderr, exitCode } = await capture(() => lufsNorm(inputPath, { output: inputPath, lufs: -16 }));

		expect(exitCode).toBeUndefined();
		expect(stderr).toMatch(/no measurable loudness/);
		expect(Buffer.compare(original, await readFile(inputPath))).toBe(0);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
		expect(existsSync(inputPath)).toBe(true);
	});

	it("rejects a target outside [-50, 0] at the CLI parser", async () => {
		await expect(parseProgram(["lufs-norm", "in.wav", "-o", "out.wav", "--lufs", "6"])).rejects.toThrow(
			/lufs must be in \[-50, 0\]/,
		);
		await expect(parseProgram(["lufs-norm", "in.wav", "-o", "out.wav", "--lufs", "-51"])).rejects.toThrow(
			/lufs must be in \[-50, 0\]/,
		);
		await expect(parseProgram(["lufs-norm", "in.wav", "-o", "out.wav", "--lufs", "Infinity"])).rejects.toThrow(
			/lufs must be in \[-50, 0\]/,
		);
		await expect(parseProgram(["lufs-norm", "in.wav", "-o", "out.wav", "--lufs", "abc"])).rejects.toThrow(
			/lufs must be in \[-50, 0\]/,
		);
	});

	it("rejects a target off the 0.1 step at both entry points", async () => {
		await expect(parseProgram(["lufs-norm", "in.wav", "-o", "out.wav", "--lufs", "-16.15"])).rejects.toThrow(
			/lufs must be in \[-50, 0\] in steps of 0\.1, received -16\.15/,
		);
		await expect(lufsNorm("in.wav", { output: "out.wav", lufs: -16.15 })).rejects.toThrow(
			/lufs must be in \[-50, 0\] in steps of 0\.1, received -16\.15/,
		);
	});

	it("accepts a target on the 0.1 step", async () => {
		const parsed = await parseProgram(["lufs-norm", "in.wav", "-o", "out.wav", "--lufs", "-16.1"]).catch(
			(error: unknown) => error,
		);

		expect(String(parsed)).not.toMatch(/lufs must be in/);
	});

	it("rejects a target outside [-50, 0] at the exported function", async () => {
		await expect(lufsNorm("in.wav", { output: "out.wav", lufs: 6 })).rejects.toThrow(/lufs must be in \[-50, 0\]/);
		await expect(lufsNorm("in.wav", { output: "out.wav", lufs: -51 })).rejects.toThrow(/lufs must be in \[-50, 0\]/);
	});

	it("accepts the [-50, 0] endpoints", async () => {
		const inputPath = join(workingDirectory, "bounds.wav");
		const minus50Path = join(workingDirectory, "bounds-minus50.wav");
		const zeroPath = join(workingDirectory, "bounds-zero.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE * 3, 1, SAMPLE_RATE, 997, dbToLinear(-20)));
		await capture(async () => {
			await parseProgram(["lufs-norm", inputPath, "-o", minus50Path, "--lufs", "-50"]);
		});
		await capture(() => lufsNorm(inputPath, { output: zeroPath, lufs: 0 }));

		expect(Math.abs((await measureFileIndependent(minus50Path)) - -50)).toBeLessThan(0.1);
		expect(Math.abs((await measureFileIndependent(zeroPath)) - 0)).toBeLessThan(0.1);
	});

	it("normalizes a 5.1 source by the loudness its channel mask weights", async () => {
		const inputPath = join(workingDirectory, "surround.wav");
		const outputPath = join(workingDirectory, "surround-out.wav");
		const frameCount = SAMPLE_RATE * 3;
		const [sine = new Float64Array(0)] = createSine(frameCount, 1, SAMPLE_RATE, 997, dbToLinear(-20));
		const channels = Array.from({ length: 6 }, (_channel, index) =>
			index === 4 ? sine : new Float64Array(frameCount),
		);
		const expectedSourceLufs = measureIndependent([sine], SAMPLE_RATE) + 10 * Math.log10(1.41);

		await writeExtensibleWav(inputPath, {
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			bitDepth: "32f",
			channelMask: 0x3f,
			channels,
		});

		const { stdout, exitCode } = await capture(() => lufsNorm(inputPath, { output: outputPath, lufs: -16 }));
		const sourceLufs = Number(/^source integrated +(-?\d+\.\d{2}) LUFS/m.exec(stdout)?.[1]);
		const appliedGainDb = Number(/^applied gain +(-?\d+\.\d{2}) dB/m.exec(stdout)?.[1]);
		const output = await readAll(outputPath);

		expect(exitCode).toBeUndefined();
		expect(Math.abs(sourceLufs - expectedSourceLufs)).toBeLessThan(0.01);
		expect(Math.abs(appliedGainDb - (-16 - expectedSourceLufs))).toBeLessThan(0.01);
		expect(output).toHaveLength(6);
		expect(
			linearToDb((output[4] ?? new Float64Array(0)).reduce((peak, sample) => Math.max(peak, sample), 0)),
		).toBeCloseTo(-20 + appliedGainDb, 1);
	});

	it("warns when predicted output true peak exceeds 0 dBTP", async () => {
		const inputPath = join(workingDirectory, "boost.wav");
		const outputPath = join(workingDirectory, "boost-out.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE * 3, 1, SAMPLE_RATE, 997, dbToLinear(-20)));

		const { stdout, stderr } = await capture(() => lufsNorm(inputPath, { output: outputPath, lufs: 0 }));

		expect(stdout).toMatch(/output true peak/);
		expect(stderr).toMatch(/warning: predicted output true peak/);
		expect(stderr).toMatch(/exceeds 0 dBTP/);
	});
});

describe("lufs-norm on stdin and stdout", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-lufs-norm-stdio-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("reads - and writes -o - byte-identically to file mode, printing the summary to stderr for -o -", async () => {
		const inputPath = join(workingDirectory, "input.wav");

		await writeWav(inputPath, createSine(2 * SAMPLE_RATE, 2, SAMPLE_RATE, 997, 0.5));

		const runs = await runStdioCombinations({
			command: ["lufs-norm", "--lufs", "-20"],
			inputPath,
			directory: workingDirectory,
		});
		const stdoutSummary = runs.fileRun.stderr + runs.summaryFor("-");

		expect(runs.fileRun.exitCode).toBeUndefined();
		expect(runs.fileOutput.length).toBeGreaterThan(0);
		expect(runs.stdinOutput.equals(runs.fileOutput)).toBe(true);
		expect(runs.stdoutRun.stdout.equals(runs.fileOutput)).toBe(true);
		expect(runs.pipeRun.stdout.equals(runs.fileOutput)).toBe(true);
		expect(runs.stdinRun.stdout.toString("utf8")).toBe(runs.summaryFor(runs.stdinPath));
		expect(runs.stdinRun.stderr).toBe(runs.fileRun.stderr);
		expect(runs.stdoutRun.stderr).toBe(stdoutSummary);
		expect(runs.pipeRun.stderr).toBe(stdoutSummary);
		expect(runs.pipeRun.stderr).toMatch(/output {4,}-\n$/);
		expect([runs.stdinRun.exitCode, runs.stdoutRun.exitCode, runs.pipeRun.exitCode]).toEqual([
			undefined,
			undefined,
			undefined,
		]);
	});

	it("passes silence on stdin through to the input's samples", async () => {
		const inputPath = join(workingDirectory, "silence.wav");

		await writeWav(inputPath, [new Float64Array(4800), new Float64Array(4800)]);

		const runs = await runSilenceOnStdin({
			command: ["lufs-norm", "--lufs", "-20"],
			inputPath,
			directory: workingDirectory,
		});

		expect(runs.fileRun.exitCode).toBeUndefined();
		expect(runs.pipeRun.exitCode).toBeUndefined();
		expect(runs.pipeRun.stderr).toContain("passed through unchanged");
		expect(runs.fileSamples).toEqual(runs.inputSamples);
		expect(runs.pipeSamples).toEqual(runs.inputSamples);
	});
});

describe("lufs-norm on raw PCM and stream options", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-lufs-norm-raw-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const pathOf = (name: string): string => join(workingDirectory, name);

	const surroundSignal = (channelCount: number): Array<Float64Array> =>
		createNoise(48000, channelCount, 11).map((channel, index) =>
			channel.map((sample) => sample * (0.2 + 0.1 * index)),
		);

	const appliedGainOf = (run: { readonly stdout: Buffer }): number =>
		Number(/applied gain\s+(-?[\d.]+) dB/.exec(run.stdout.toString("utf8"))?.[1]);

	const maskOf = async (path: string): Promise<number> => {
		const reader = await WavReader.open(path);

		await reader.close();

		return reader.format.channelMask;
	};

	it("writes the file-mode output's data bytes for raw s24le in and out, and its samples from a raw file", async () => {
		const inputPath = pathOf("input.wav");

		await writeTestWav(inputPath, createNoise(96000, 2, 7), { bitDepth: "24" });
		await expectRawMatchesFileMode({
			command: ["lufs-norm", "--lufs", "-20"],
			inputPath,
			directory: workingDirectory,
		});
	});

	it("refuses -ar on a WAV input, ignores -ac, and refuses a -ch_layout of another count", async () => {
		const inputPath = pathOf("stereo.wav");

		await writeTestWav(inputPath, createNoise(48000, 2, 5), { bitDepth: "16" });

		const plain = await runCli(["lufs-norm", inputPath, "-o", "-"]);
		const rate = await runCli(["lufs-norm", "-ar", "48000", inputPath, "-o", "-"]);
		const sampleRate = await runCli(["lufs-norm", "-sample_rate", "22050", inputPath, "-o", "-"]);
		const six = await runCli(["lufs-norm", "-ac", "6", inputPath, "-o", "-"]);
		const zero = await runCli(["lufs-norm", "-ac", "0", inputPath, "-o", "-"]);
		const layout = await runCli(["lufs-norm", "-ch_layout", "5.1", inputPath, "-o", "-"]);

		expect(rate.stderr).toBe(`error: -ar applies to a raw input, and "${inputPath}" is WAV\n`);
		expect(sampleRate.stderr).toBe(`error: -sample_rate applies to a raw input, and "${inputPath}" is WAV\n`);
		expect(six.stdout.equals(plain.stdout)).toBe(true);
		expect(zero.stdout.equals(plain.stdout)).toBe(true);
		expect(layout.stderr).toBe(`error: Channel layout "5.1" has 6 channels, and "${inputPath}" has 2\n`);
		expect([rate.exitCode, sampleRate.exitCode, layout.exitCode]).toEqual([1, 1, 1]);
	});

	it("weighs a plain stereo WAV's channels as side channels under -ch_layout SL+SR", async () => {
		const inputPath = pathOf("stereo.wav");
		const sidePath = pathOf("side.wav");
		const silentPath = pathOf("silent.wav");
		const silentSidePath = pathOf("silent-side.wav");

		await writeTestWav(inputPath, createNoise(96000, 2, 5), { bitDepth: "16" });
		await writeTestWav(silentPath, [new Float64Array(4800), new Float64Array(4800)], { bitDepth: "16" });

		const plain = await runCli(["lufs-norm", inputPath, "-o", pathOf("plain.wav")]);
		const side = await runCli(["lufs-norm", "-ch_layout", "SL+SR", inputPath, "-o", sidePath]);
		const silent = await runCli(["lufs-norm", "-ch_layout", "SL+SR", silentPath, "-o", silentSidePath]);

		expect(appliedGainOf(plain) - appliedGainOf(side)).toBeCloseTo(10 * Math.log10(1.41), 1);
		expect(Math.abs(appliedGainOf(plain) - appliedGainOf(side) - 10 * Math.log10(1.41))).toBeLessThanOrEqual(0.01);
		expect(await maskOf(sidePath)).toBe(0x600);
		expect(silent.stderr).toContain("passed through unchanged");
		expect(await maskOf(silentSidePath)).toBe(0x600);
		expect((await dataBytesOf(silentSidePath)).equals(await dataBytesOf(silentPath))).toBe(true);
	});

	it("relabels a raw input with no layout through an output -ch_layout, weighing it as an input -ch_layout does", async () => {
		const sourcePath = pathOf("six.wav");

		await writeTestWav(sourcePath, surroundSignal(6), { bitDepth: "16" });

		const raw = await dataBytesOf(sourcePath);
		const relabelled = await runCli(
			["lufs-norm", "-f", "s16le", "-ac", "6", "-", "-ch_layout", "5.1", "-o", pathOf("a.wav")],
			raw,
		);
		const stated = await runCli(["lufs-norm", "-f", "s16le", "-ch_layout", "5.1", "-", "-o", pathOf("b.wav")], raw);
		const unstated = await runCli(["lufs-norm", "-f", "s16le", "-ac", "6", "-", "-o", pathOf("c.wav")], raw);

		expect([relabelled.exitCode, stated.exitCode, unstated.exitCode]).toEqual([undefined, undefined, undefined]);
		expect((await readFile(pathOf("a.wav"))).equals(await readFile(pathOf("b.wav")))).toBe(true);
		expect(await maskOf(pathOf("a.wav"))).toBe(0x3f);
		expect(appliedGainOf(relabelled)).toBe(appliedGainOf(stated));
		expect(appliedGainOf(relabelled)).not.toBe(appliedGainOf(unstated));
	});

	it("fails an output -ar that would resample before the reader opens or reads a block", async () => {
		const sourcePath = pathOf("rate.wav");

		await writeTestWav(sourcePath, createNoise(4800, 2, 3), { bitDepth: "16" });

		const openRaw = vi.spyOn(WavStreamReader, "openRaw");
		const blocks = vi.spyOn(WavStreamReader.prototype, "blocks");
		const raw = await runCli(
			["lufs-norm", "-f", "s16le", "-ar", "48000", "-ac", "2", "-", "-ar", "44100", "-o", "-"],
			await dataBytesOf(sourcePath),
		);
		const wav = await runCli(["lufs-norm", "-", "-ar", "44100", "-o", "-"], await readFile(sourcePath));
		const message =
			"error: loudness-tool keeps the input's sample rate: output -ar 44100 differs from the input's 48000\n";

		expect([raw.stderr, wav.stderr]).toEqual([message, message]);
		expect([raw.exitCode, wav.exitCode]).toEqual([1, 1]);
		expect(openRaw).not.toHaveBeenCalled();
		expect(blocks).not.toHaveBeenCalled();
		expect(raw.stdout.length + wav.stdout.length).toBe(0);
	});

	it("accepts BAG's output arguments on a matching raw input", async () => {
		const sourcePath = pathOf("bag.wav");

		await writeTestWav(sourcePath, createNoise(48000, 2, 3), { bitDepth: "32f" });

		const bag = ["-f", "f32le", "-ar", "48000", "-ac", "2"];
		const run = await runCli(["lufs-norm", ...bag, "pipe:0", ...bag, "-o", "pipe:1"], await dataBytesOf(sourcePath));

		expect(run.exitCode).toBeUndefined();
		expect(run.stdout.length).toBe(48000 * 2 * 4);
	});

	it.each([
		[
			"5.1 input, output -ac 2 -ch_layout 5.1",
			["-f", "s16le", "-ch_layout", "5.1"],
			["-ac", "2", "-ch_layout", "5.1"],
			6,
			0x3f,
		],
		["5.1 input, output -ac 6", ["-f", "s16le", "-ch_layout", "5.1"], ["-ac", "6"], 6, 0x3f],
		["raw -ac 6 input, output -ac 6", ["-f", "s16le", "-ac", "6"], ["-ac", "6"], 6, 0],
		["raw -ac 9 input, output -ac 9", ["-f", "s16le", "-ac", "9"], ["-ac", "9"], 9, 0],
		["5.1 input, output -ar 0", ["-f", "s16le", "-ch_layout", "5.1"], ["-ar", "0"], 6, 0x3f],
		["5.1 input, output -ac 0", ["-f", "s16le", "-ch_layout", "5.1"], ["-ac", "0"], 6, 0x3f],
		["5.1 input, output -ch_layout 6C", ["-f", "s16le", "-ch_layout", "5.1"], ["-ch_layout", "6C"], 6, 0x3f],
	] as const)("accepts a %s", async (_label, input, output, channelCount, channelMask) => {
		const sourcePath = pathOf("source.wav");
		const outputPath = pathOf("out.wav");

		await writeTestWav(sourcePath, surroundSignal(channelCount), { bitDepth: "16" });

		const run = await runCli(
			["lufs-norm", ...input, "-ar", "48000", "-", ...output, "-o", outputPath],
			await dataBytesOf(sourcePath),
		);
		const reader = await WavReader.open(outputPath);

		await reader.close();

		expect(run.exitCode).toBeUndefined();
		expect(reader.format).toMatchObject({ sampleRate: 48000, channelCount, channelMask });
	});

	it.each([
		[
			["-ch_layout", "5.1"],
			["-ch_layout", "5.1(side)"],
			"output -ch_layout 5.1(side) differs from the input's layout 0x3f",
		],
		[["-ch_layout", "5.1"], ["-ch_layout", "6.0"], "output -ch_layout 6.0 differs from the input's layout 0x3f"],
		[["-ac", "6"], ["-ch_layout", "stereo"], "output -ch_layout stereo has 2 channels, the input 6"],
		[
			["-ch_layout", "5.1(side)"],
			["-ac", "6"],
			"output -ac 6 would rematrix the input's layout 0x60f to 6's default layout",
		],
		[["-ac", "6"], ["-ac", "2"], "output -ac 2 differs from the input's 6"],
	])("refuses input %j with output %j", async (input, output, message) => {
		const run = await runCli(
			["lufs-norm", "-f", "s16le", ...input, "-", ...output, "-o", "-"],
			Buffer.alloc(2 * 6 * 4800),
		);

		expect(run.stderr).toBe(`error: loudness-tool keeps the input's channels: ${message}\n`);
		expect(run.exitCode).toBe(1);
	});

	it.each([
		[["-ar", "-1"], "error: Invalid sample rate: -1\n"],
		[["-ac", "-1"], "error: Invalid channel count: -1\n"],
	])("refuses the output option %j", async (output, message) => {
		const run = await runCli(["lufs-norm", "-f", "s16le", "-ac", "2", "-", ...output, "-o", "-"], Buffer.alloc(400));

		expect(run.stderr).toBe(message);
		expect(run.exitCode).toBe(1);
	});

	it("passes raw silence through as its input bytes, as zero floats under -f f32le, and an 8-bit WAV as its data bytes under -f u8", async () => {
		const silence = Buffer.alloc(2 * 2 * 4800);
		const raw = ["-f", "s16le", "-ar", "48000", "-ac", "2", "-"];
		const same = await runCli(["lufs-norm", ...raw, "-f", "s16le", "-o", "-"], silence);
		const floats = await runCli(["lufs-norm", ...raw, "-f", "f32le", "-o", "-"], silence);
		const eightBitPath = pathOf("silent8.wav");

		await writeTestWav(eightBitPath, [new Float64Array(4800), new Float64Array(4800)], { bitDepth: "8" });

		const eightBit = await runCli(["lufs-norm", eightBitPath, "-f", "u8", "-o", "-"]);

		expect(same.stdout.equals(silence)).toBe(true);
		expect(floats.stdout.equals(Buffer.alloc(4 * 2 * 4800))).toBe(true);
		expect(eightBit.stdout.equals(await dataBytesOf(eightBitPath))).toBe(true);
	});
});
