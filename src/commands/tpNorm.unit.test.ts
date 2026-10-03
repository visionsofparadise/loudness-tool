import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli";
import { dbToLinear, linearToDb } from "../utils/db";
import {
	captureWrites,
	dataBytesOf,
	decodedSamplesOf,
	expectRawMatchesFileMode,
	runCli,
	runSilenceOnStdin,
	runStdioCombinations,
	writeTestWav,
} from "../utils/testCli";
import { createNoise, createSine } from "../utils/testSignals";
import { WavReader, type AudioBlock } from "../wav/WavReader";
import { encodeSample } from "../wav/utils/sampleCodec";
import { WavWriter } from "../wav/WavWriter";
import { tpNorm } from "./tpNorm";
import type { SourceBitDepth } from "../wav/utils/wavFormat";

vi.mock("node:fs/promises", { spy: true });

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

const measureFileIndependent = async (path: string): Promise<number> => measureIndependent(await readAll(path));

const capture = async (run: () => Promise<void>): Promise<{ stdout: string; stderr: string }> => {
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	const writeOut = vi
		.spyOn(process.stdout, "write")
		.mockImplementation(captureWrites((chunk) => stdout.push(chunk.toString("utf8"))));
	const writeErr = vi
		.spyOn(process.stderr, "write")
		.mockImplementation(captureWrites((chunk) => stderr.push(chunk.toString("utf8"))));

	try {
		await run();

		return { stdout: stdout.join(""), stderr: stderr.join("") };
	} finally {
		writeOut.mockRestore();
		writeErr.mockRestore();
	}
};

const writeUnsigned8BitSilence = async (path: string, frameCount: number): Promise<void> => {
	const dataSize = frameCount;
	const file = Buffer.alloc(44 + dataSize);

	file.write("RIFF", 0);
	file.writeUInt32LE(36 + dataSize, 4);
	file.write("WAVE", 8);
	file.write("fmt ", 12);
	file.writeUInt32LE(16, 16);
	file.writeUInt16LE(1, 20);
	file.writeUInt16LE(1, 22);
	file.writeUInt32LE(SAMPLE_RATE, 24);
	file.writeUInt32LE(SAMPLE_RATE, 28);
	file.writeUInt16LE(1, 32);
	file.writeUInt16LE(8, 34);
	file.write("data", 36);
	file.writeUInt32LE(dataSize, 40);
	file.fill(128, 44);

	await writeFile(path, file);
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

		const { stdout } = await capture(() => tpNorm(inputPath, { output: outputPath, tp: target }));
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

		await capture(() => tpNorm(inputPath, { output: outputPath, tp: target }));

		expect(Math.abs(linearToDb(await measureFileIndependent(outputPath)) - target)).toBeLessThan(0.01);
	});

	it("passes silence through unchanged", async () => {
		const inputPath = join(workingDirectory, "silence.wav");
		const outputPath = join(workingDirectory, "silence-out.wav");
		const silence = [new Float64Array(64)];

		await writeWav(inputPath, silence);

		const { stdout, stderr } = await capture(() => tpNorm(inputPath, { output: outputPath, tp: -1 }));
		const output = await readAll(outputPath);

		expect(stdout).toBe("");
		expect(stderr).toMatch(/no measurable true peak/);
		expect(output[0]?.length).toBe(64);
		expect(Array.from(output[0] ?? [])).toEqual(Array.from(silence[0] ?? []));
		expect(await measureFileIndependent(outputPath)).toBe(0);
		expect(Buffer.compare(await readFile(inputPath), await readFile(outputPath))).toBe(0);
	});

	it("leaves destination file bytes untouched when the silence pass-through rename fails", async () => {
		const inputPath = join(workingDirectory, "silence.wav");
		const outputPath = join(workingDirectory, "existing.wav");

		await writeWav(inputPath, [new Float64Array(64)]);
		await writeFile(outputPath, "original-bytes");

		const unlinkSpy = vi.spyOn(fsPromises, "unlink");
		const renameSpy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("rename failed"));

		try {
			await expect(tpNorm(inputPath, { output: outputPath, tp: -1 })).rejects.toThrow(
				`Failed to replace "${outputPath}" with`,
			);

			expect(await readFile(outputPath, "utf8")).toBe("original-bytes");
			expect(unlinkSpy.mock.calls.some((call) => call[0] === outputPath)).toBe(false);
			expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
		} finally {
			renameSpy.mockRestore();
			unlinkSpy.mockRestore();
		}
	});

	it("copies a silent 8-bit source byte-identically", async () => {
		const inputPath = join(workingDirectory, "silence-8.wav");
		const outputPath = join(workingDirectory, "silence-8-out.wav");

		await writeUnsigned8BitSilence(inputPath, 64);

		const { stdout, stderr } = await capture(() => tpNorm(inputPath, { output: outputPath, tp: -1 }));

		expect(stdout).toBe("");
		expect(stderr).toMatch(/no measurable true peak/);
		expect(Buffer.compare(await readFile(inputPath), await readFile(outputPath))).toBe(0);
	});

	it("lands a 1e-12-peak 32f source on the linear target", async () => {
		const inputPath = join(workingDirectory, "tiny.wav");
		const outputPath = join(workingDirectory, "tiny-out.wav");
		const target = -1;
		const tiny = new Float64Array(256).fill(1e-12);

		await writeWav(inputPath, [tiny]);

		const { stdout } = await capture(() => tpNorm(inputPath, { output: outputPath, tp: target }));

		expect(Math.abs((await measureFileIndependent(outputPath)) - dbToLinear(target))).toBeLessThan(1e-6);
		expect(stdout).not.toMatch(/-200\.00 dBTP/);

		const reported = stdout.match(/source true peak\s+(-?\d+\.\d+) dBTP/);

		expect(Number(reported?.[1])).toBeLessThan(-220);
	});

	it("supports in-place -o <input>", async () => {
		const inputPath = join(workingDirectory, "inplace.wav");
		const target = -1;

		await writeWav(inputPath, createSine(4800, 2, SAMPLE_RATE, 997, 0.5));
		await capture(() => tpNorm(inputPath, { output: inputPath, tp: target }));

		expect(Math.abs(linearToDb(await measureFileIndependent(inputPath)) - target)).toBeLessThan(0.01);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("accepts a 4-channel source", async () => {
		const inputPath = join(workingDirectory, "quad.wav");
		const outputPath = join(workingDirectory, "quad-out.wav");
		const target = -1;

		await writeWav(inputPath, createSine(4800, 4, SAMPLE_RATE, 997, 0.5));
		await capture(() => tpNorm(inputPath, { output: outputPath, tp: target }));

		expect(Math.abs(linearToDb(await measureFileIndependent(outputPath)) - target)).toBeLessThan(0.01);
	});

	it("rejects a target outside [-24, 0) at the CLI parser", async () => {
		await expect(parseProgram(["tp-norm", "in.wav", "-o", "out.wav", "--tp", "-400"])).rejects.toThrow(
			/tp must be in \[-24, 0\)/,
		);
		await expect(parseProgram(["tp-norm", "in.wav", "-o", "out.wav", "--tp", "0"])).rejects.toThrow(
			/tp must be in \[-24, 0\)/,
		);
		await expect(parseProgram(["tp-norm", "in.wav", "-o", "out.wav", "--tp", "1"])).rejects.toThrow(
			/tp must be in \[-24, 0\)/,
		);
	});

	it("rejects a target outside [-24, 0) at the exported function", async () => {
		await expect(tpNorm("in.wav", { output: "out.wav", tp: -400 })).rejects.toThrow(/tp must be in \[-24, 0\)/);
		await expect(tpNorm("in.wav", { output: "out.wav", tp: 0 })).rejects.toThrow(/tp must be in \[-24, 0\)/);
		await expect(tpNorm("in.wav", { output: "out.wav", tp: 1 })).rejects.toThrow(/tp must be in \[-24, 0\)/);
	});

	it("accepts a target of -24 dBTP", async () => {
		const inputPath = join(workingDirectory, "bound.wav");
		const outputPath = join(workingDirectory, "bound-out.wav");
		const target = -24;

		await writeWav(inputPath, createSine(12000, 1, SAMPLE_RATE, 997, 1));
		await capture(async () => {
			await parseProgram(["tp-norm", inputPath, "-o", outputPath, "--tp", "-24"]);
		});

		expect(Math.abs(linearToDb(await measureFileIndependent(outputPath)) - target)).toBeLessThan(0.01);
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

describe("tp-norm on stdin and stdout", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-tp-norm-stdio-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("reads - and writes -o - byte-identically to file mode, printing the summary to stderr for -o -", async () => {
		const inputPath = join(workingDirectory, "input.wav");

		await writeWav(inputPath, createSine(2 * SAMPLE_RATE, 2, SAMPLE_RATE, 997, 0.5));

		const runs = await runStdioCombinations({
			command: ["tp-norm", "--tp", "-3"],
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
			command: ["tp-norm", "--tp", "-3"],
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

describe("tp-norm on raw PCM", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-tp-norm-raw-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const loudInput = async (bitDepth: SourceBitDepth, name = "input.wav"): Promise<string> => {
		const inputPath = join(workingDirectory, name);

		await writeTestWav(inputPath, createNoise(96000, 2, 7), { bitDepth });

		return inputPath;
	};

	it("writes the file-mode output's data bytes for raw s24le in and out, and its samples from a raw file", async () => {
		await expectRawMatchesFileMode({
			command: ["tp-norm", "--tp", "-3"],
			inputPath: await loudInput("24"),
			directory: workingDirectory,
		});
	});

	it("writes f32le, f64le and u8 outputs at the depth -f names", async () => {
		const floatPath = await loudInput("32f");
		const filePath = join(workingDirectory, "float.wav");
		const fileRun = await runCli(["tp-norm", floatPath, "-o", filePath]);
		const f32 = await runCli(["tp-norm", floatPath, "-f", "f32le", "-o", "-"]);
		const f64 = await runCli(["tp-norm", floatPath, "-f", "f64le", "-o", "-"]);
		const fileData = await dataBytesOf(filePath);
		const doubles = Array.from({ length: f64.stdout.length / 8 }, (_, index) =>
			Math.fround(f64.stdout.readDoubleLE(index * 8)),
		);
		const floats = Array.from({ length: fileData.length / 4 }, (_, index) => fileData.readFloatLE(index * 4));

		expect([fileRun.exitCode, f32.exitCode, f64.exitCode]).toEqual([undefined, undefined, undefined]);
		expect(f32.stdout.equals(fileData)).toBe(true);
		expect(doubles).toEqual(floats);

		const sixteenPath = await loudInput("16", "sixteen.wav");
		const sixteenOutput = join(workingDirectory, "sixteen-out.wav");

		await runCli(["tp-norm", sixteenPath, "-o", sixteenOutput]);

		const u8 = await runCli(["tp-norm", sixteenPath, "-f", "u8", "-o", "-"]);
		const sixteen = await decodedSamplesOf(sixteenOutput);
		const interleaved = Array.from(sixteen[0] ?? []).flatMap((sample, index) => [sample, sixteen[1]?.[index] ?? 0]);

		expect(u8.stdout.length).toBe(interleaved.length);
		const code = Buffer.alloc(1);

		interleaved.forEach((sample, index) => {
			encodeSample(code, 0, sample, "8");
			expect(Math.abs((u8.stdout[index] ?? 0) - (code[0] ?? 0))).toBeLessThanOrEqual(1);
		});
	});

	it("fails a 4 Hz WAV input before any pass", async () => {
		const inputPath = join(workingDirectory, "slow.wav");

		await writeTestWav(inputPath, createNoise(8, 2, 3), { bitDepth: "16", sampleRate: 4 });

		const run = await runCli(["tp-norm", inputPath, "-o", "-"]);

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toBe("error: Unsupported sample rate: 4\n");
		expect(run.stdout.length).toBe(0);
	});

	it.each([
		[["pipe:"], ["-o", "pipe:"]],
		[["pipe:0"], ["-o", "pipe:1"]],
		[["pipe: 0"], ["-o", "pipe:+1"]],
		[["-"], ["-o", "-"]],
	])("reads %j and writes %j as stdin and stdout", async (inputTokens, outputTokens) => {
		const inputPath = await loudInput("16");
		const rawData = await dataBytesOf(inputPath);
		const raw = ["-f", "s16le", "-ar", "48000", "-ac", "2"];
		const reference = await runCli(["tp-norm", ...raw, "-", "-f", "s16le", "-o", "-"], rawData);
		const run = await runCli(["tp-norm", ...raw, ...inputTokens, "-f", "s16le", ...outputTokens], rawData);

		expect(run.exitCode).toBeUndefined();
		expect(run.stdout.equals(reference.stdout)).toBe(true);
		expect(run.stderr).toBe(reference.stderr.replace(/-\n$/, `${outputTokens[1] ?? ""}\n`));
	});

	it("writes the audio to stderr for -o pipe:2 with the summary on stdout", async () => {
		const inputPath = await loudInput("16");
		const rawData = await dataBytesOf(inputPath);
		const raw = ["-f", "s16le", "-ar", "48000", "-ac", "2"];
		const reference = await runCli(["tp-norm", ...raw, "-", "-f", "s16le", "-o", "-"], rawData);
		const run = await runCli(["tp-norm", ...raw, "-", "-f", "s16le", "-o", "pipe:2"], rawData);

		expect(run.exitCode).toBeUndefined();
		expect(run.stderrBytes.equals(reference.stdout)).toBe(true);
		expect(run.stdout.toString("utf8")).toBe(reference.stderr.replace(/-\n$/, "pipe:2\n"));
	});

	it.each(["pipe:abc", "pipe:-1", "pipe:1 "])("fails the pipe name %j", async (path) => {
		const asInput = await runCli(["tp-norm", "-f", "s16le", path, "-o", "-"]);
		const asOutput = await runCli(["tp-norm", "-f", "s16le", "-", "-o", path], Buffer.alloc(4));

		expect([asInput.exitCode, asOutput.exitCode]).toEqual([1, 1]);
		expect(asInput.stderr).toMatch(/^error: Cannot open "pipe:/);
		expect(asOutput.stderr).toMatch(/^error: Cannot open "pipe:/);
	});

	it("passes raw silence through as its input bytes, as zero floats under -f f32le, and an 8-bit WAV as its data bytes under -f u8", async () => {
		const silence = Buffer.alloc(2 * 2 * 4800);
		const raw = ["-f", "s16le", "-ar", "48000", "-ac", "2", "-"];
		const same = await runCli(["tp-norm", ...raw, "-f", "s16le", "-o", "-"], silence);
		const floats = await runCli(["tp-norm", ...raw, "-f", "f32le", "-o", "-"], silence);
		const eightBitPath = join(workingDirectory, "silent8.wav");

		await writeTestWav(eightBitPath, [new Float64Array(4800), new Float64Array(4800)], { bitDepth: "8" });

		const eightBit = await runCli(["tp-norm", eightBitPath, "-f", "u8", "-o", "-"]);

		expect(same.stdout.equals(silence)).toBe(true);
		expect(floats.stdout.equals(Buffer.alloc(4 * 2 * 4800))).toBe(true);
		expect(eightBit.stdout.equals(await dataBytesOf(eightBitPath))).toBe(true);
		for (const run of [same, floats, eightBit]) {
			expect(run.exitCode).toBeUndefined();
			expect(run.stderr).toBe("source has no measurable true peak; passed through unchanged\n");
		}
	});
});
