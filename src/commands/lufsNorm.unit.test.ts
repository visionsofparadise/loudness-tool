import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli";
import { dbToLinear } from "../utils/db";
import { createSine } from "../utils/testSignals";
import { WavReader, type AudioBlock } from "../wav/WavReader";
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
	const writer = await WavWriter.create(path, {
		sampleRate: SAMPLE_RATE,
		channelCount: channels.length,
		bitDepth: "32f",
	});

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

	it("rejects a non-finite target", async () => {
		await expect(parseProgram(["lufs-norm", "in.wav", "-o", "out.wav", "--lufs", "Infinity"])).rejects.toThrow(
			/lufs must be finite/,
		);
		await expect(parseProgram(["lufs-norm", "in.wav", "-o", "out.wav", "--lufs", "abc"])).rejects.toThrow(
			/lufs must be finite/,
		);
	});
});
