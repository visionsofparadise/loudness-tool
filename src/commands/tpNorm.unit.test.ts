import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli";
import { linearToDb } from "../utils/db";
import { createSine } from "../utils/testSignals";
import { WavReader, type AudioBlock } from "../wav/WavReader";
import { WavWriter } from "../wav/WavWriter";
import { tpNorm } from "./tpNorm";

const SAMPLE_RATE = 48000;

const PHASE_COEFFICIENTS: ReadonlyArray<ReadonlyArray<number>> = [
	[
		0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875,
		-0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125,
	],
	[
		-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625,
		-0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375,
	],
	[
		-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625, 0.465087890625,
		-0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875,
	],
	[
		-0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875, 0.1373291015625,
		-0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375,
	],
];
const PHASES = PHASE_COEFFICIENTS.length;
const TAPS = PHASE_COEFFICIENTS[0]?.length ?? 0;
const TAIL_POSITIONS = TAPS - 1;

const directConvolution = (input: Float64Array): Float64Array => {
	const positions = input.length + TAIL_POSITIONS;
	const output = new Float64Array(positions * PHASES);

	for (let position = 0; position < positions; position++) {
		for (let phase = 0; phase < PHASES; phase++) {
			const coefficients = PHASE_COEFFICIENTS[phase];
			let sum = 0;

			for (let tap = 0; tap < TAPS; tap++) {
				const inputIndex = position - tap;
				const sample = inputIndex >= 0 && inputIndex < input.length ? (input[inputIndex] ?? 0) : 0;

				sum += (coefficients?.[tap] ?? 0) * sample;
			}

			output[position * PHASES + phase] = sum;
		}
	}

	return output;
};

const measureIndependent = (channels: ReadonlyArray<Float64Array>): number => {
	let peak = 0;

	for (const channel of channels) {
		for (const sample of channel) {
			peak = Math.max(peak, Math.abs(sample));
		}

		const interpolated = directConvolution(channel);

		for (const sample of interpolated) {
			peak = Math.max(peak, Math.abs(sample));
		}
	}

	return peak;
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

const measureFileIndependent = async (path: string): Promise<number> => measureIndependent(await readAll(path));

const captureStdout = async (run: () => Promise<void>): Promise<string> => {
	const stdout: Array<string> = [];
	const writeOut = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout.push(String(chunk));

		return true;
	});

	try {
		await run();

		return stdout.join("");
	} finally {
		writeOut.mockRestore();
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

describe("tp-norm", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-tp-norm-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("attenuates a loud sine to the target within 0.01 dB", async () => {
		const inputPath = join(workingDirectory, "loud.wav");
		const outputPath = join(workingDirectory, "loud-out.wav");
		const target = -1;

		await writeWav(inputPath, createSine(12000, 1, SAMPLE_RATE, 997, 1));

		const stdout = await captureStdout(() => tpNorm(inputPath, { output: outputPath, tp: target }));
		const measuredDb = linearToDb(await measureFileIndependent(outputPath));

		expect(Math.abs(measuredDb - target)).toBeLessThan(0.01);
		expect(stdout).toMatch(/source true peak/);
		expect(stdout).toMatch(/target\s+-1\.00 dBTP/);
		expect(stdout).toContain(outputPath);
	});

	it("amplifies a quiet sine to the target within 0.01 dB", async () => {
		const inputPath = join(workingDirectory, "quiet.wav");
		const outputPath = join(workingDirectory, "quiet-out.wav");
		const target = -1;

		await writeWav(inputPath, createSine(12000, 1, SAMPLE_RATE, 997, 0.25));

		await captureStdout(() => tpNorm(inputPath, { output: outputPath, tp: target }));

		expect(Math.abs(linearToDb(await measureFileIndependent(outputPath)) - target)).toBeLessThan(0.01);
	});

	it("passes silence through unchanged", async () => {
		const inputPath = join(workingDirectory, "silence.wav");
		const outputPath = join(workingDirectory, "silence-out.wav");
		const silence = [new Float64Array(64)];

		await writeWav(inputPath, silence);
		await captureStdout(() => tpNorm(inputPath, { output: outputPath, tp: -1 }));

		const output = await readAll(outputPath);

		expect(output[0]?.length).toBe(64);
		expect(Array.from(output[0] ?? [])).toEqual(Array.from(silence[0] ?? []));
		expect(await measureFileIndependent(outputPath)).toBe(0);
	});

	it("supports in-place -o <input>", async () => {
		const inputPath = join(workingDirectory, "inplace.wav");
		const target = -1;

		await writeWav(inputPath, createSine(4800, 2, SAMPLE_RATE, 997, 0.5));
		await captureStdout(() => tpNorm(inputPath, { output: inputPath, tp: target }));

		expect(Math.abs(linearToDb(await measureFileIndependent(inputPath)) - target)).toBeLessThan(0.01);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("rejects a target that is not < 0", async () => {
		await expect(parseProgram(["tp-norm", "in.wav", "-o", "out.wav", "--tp", "0"])).rejects.toThrow(/tp must be < 0/);
		await expect(parseProgram(["tp-norm", "in.wav", "-o", "out.wav", "--tp", "1"])).rejects.toThrow(/tp must be < 0/);
	});

	it("leaves the destination untouched when a write fails", async () => {
		const inputPath = join(workingDirectory, "source.wav");
		const outputPath = join(workingDirectory, "dest.wav");
		const sourceChannels = createSine(64, 1, SAMPLE_RATE, 440, 0.8);
		const existingChannels = createSine(64, 1, SAMPLE_RATE, 220, 0.2);

		await writeWav(inputPath, sourceChannels);
		await writeWav(outputPath, existingChannels);

		const originalDestination = await readAll(outputPath);
		const writeThrough = WavWriter.prototype.write;

		vi.spyOn(WavWriter.prototype, "write").mockImplementation(async function (
			this: WavWriter,
			channels: ReadonlyArray<Float64Array>,
		): Promise<void> {
			await writeThrough.call(this, channels);
			throw new Error("injected write failure");
		});

		await expect(tpNorm(inputPath, { output: outputPath, tp: -1 })).rejects.toThrow("injected write failure");

		expect(existsSync(outputPath)).toBe(true);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);

		const destination = await readAll(outputPath);

		expect(Array.from(destination[0] ?? [])).toEqual(Array.from(originalDestination[0] ?? []));
	});
});
