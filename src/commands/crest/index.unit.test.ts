import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../cli";
import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { Fft, hannWindow } from "../../utils/Fft";
import { linearToDb } from "../../utils/db";
import { createNoise } from "../../utils/testSignals";
import { WavWriter } from "../../wav/WavWriter";
import { crest } from "./index";
import { LATTICE_ORDER } from "./utils/lattice";
import { hopSizeOf, stftFrameCount } from "./utils/stft";
import { pushWavBlocks, withWavReader } from "../utils/withWavReader";

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

const capture = async (run: () => Promise<void>): Promise<{ stdout: string; stderr: string }> => {
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

	try {
		await run();

		return { stdout: stdout.join(""), stderr: stderr.join("") };
	} finally {
		writeOut.mockRestore();
		writeErr.mockRestore();
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

const measureTruePeakDb = async (path: string): Promise<number> =>
	withWavReader(path, async (reader) => {
		const accumulator = new TruePeakAccumulator(reader.format.channelCount);

		await pushWavBlocks(reader, [accumulator]);

		return linearToDb(accumulator.finalize());
	});

const readChannel = async (path: string): Promise<Float64Array> =>
	withWavReader(path, async (reader) => {
		const channel = new Float64Array(reader.format.frameCount);
		let cursor = 0;

		for await (const block of reader.blocks()) {
			const frames = block.channels[0]?.length ?? 0;

			channel.set(block.channels[0] ?? new Float64Array(frames), cursor);
			cursor += frames;
		}

		return channel;
	});

const makeImpulses = (seconds: number, perSecond: number, dbfs: number, bedDbfs: number): Float64Array => {
	const frameCount = Math.round(seconds * SAMPLE_RATE);
	const samples = new Float64Array(frameCount);
	const period = Math.round(SAMPLE_RATE / perSecond);
	const impulse = Math.pow(10, dbfs / 20);
	const bed = Math.pow(10, bedDbfs / 20);

	for (let index = 0; index < frameCount; index++) {
		samples[index] = index % period === 0 ? impulse : bed * Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE);
	}

	return samples;
};

const makeHeadroomBearing = (frameCount: number, fundamentalHz = 100, harmonics = 40): Float64Array => {
	const samples = new Float64Array(frameCount);
	let peak = 0;

	for (let index = 0; index < frameCount; index++) {
		let value = 0;

		for (let harmonic = 1; harmonic <= harmonics; harmonic++) {
			value += Math.cos((2 * Math.PI * harmonic * fundamentalHz * index) / SAMPLE_RATE);
		}

		samples[index] = value;
		peak = Math.max(peak, Math.abs(value));
	}

	if (peak > 0) {
		const scale = 0.9 / peak;

		for (let index = 0; index < frameCount; index++) {
			samples[index] = (samples[index] ?? 0) * scale;
		}
	}

	return samples;
};

const makeMultitone = (frameCount: number): Float64Array => {
	const out = new Float64Array(frameCount);
	const frequencies = [110, 220, 330, 440, 550, 660, 880, 1320];

	for (let index = 0; index < frameCount; index++) {
		let value = 0;

		for (const frequency of frequencies) {
			value += Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
		}

		out[index] = (value / frequencies.length) * 0.6;
	}

	return out;
};

const welchMagnitude = (signal: Float64Array, frameSize: number): Float64Array => {
	const hopSize = hopSizeOf(frameSize);
	const frames = stftFrameCount(signal.length, frameSize, hopSize);
	const halfSize = frameSize / 2 + 1;
	const fft = new Fft(frameSize);
	const window = hannWindow(frameSize);
	const real = new Float64Array(frameSize);
	const imag = new Float64Array(frameSize);
	const acc = new Float64Array(halfSize);

	for (let frame = 0; frame < frames; frame++) {
		const start = frame * hopSize;

		for (let index = 0; index < frameSize; index++) {
			real[index] = (signal[start + index] ?? 0) * (window[index] ?? 0);
			imag[index] = 0;
		}

		fft.forward(real, imag);

		for (let bin = 0; bin < halfSize; bin++) {
			acc[bin] = (acc[bin] ?? 0) + Math.hypot(real[bin] ?? 0, imag[bin] ?? 0);
		}
	}

	if (frames > 0) {
		for (let bin = 0; bin < halfSize; bin++) {
			acc[bin] = (acc[bin] ?? 0) / frames;
		}
	}

	return acc;
};

describe("crest", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-crest-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("rejects invalid flags", async () => {
		await expect(parseProgram(["crest", "in.wav", "-o", "out.wav", "--smoothing", "-1"])).rejects.toThrow(
			/smoothing must be >= 0/,
		);
		await expect(parseProgram(["crest", "in.wav", "-o", "out.wav", "--frame-size", "1000"])).rejects.toThrow(
			/frame-size must be a power of two >= 4/,
		);
		await expect(parseProgram(["crest", "in.wav", "-o", "out.wav", "--frame-size", "1.5"])).rejects.toThrow(
			/frame-size must be a power of two >= 4/,
		);
		await expect(parseProgram(["crest", "in.wav", "-o", "out.wav", "--frame-size", "6442450944"])).rejects.toThrow(
			/frame-size must be a power of two >= 4/,
		);
		await expect(
			parseProgram(["crest", "in.wav", "-o", "out.wav", "--frame-size", String(2 ** 51 + 1)]),
		).rejects.toThrow(/frame-size must be a power of two >= 4/);
		await expect(parseProgram(["crest", "in.wav", "-o", "out.wav", "--frame-size", "2"])).rejects.toThrow(
			/frame-size must be a power of two >= 4/,
		);
		await expect(crest("in.wav", { output: "out.wav", frameSize: 2 })).rejects.toThrow(
			/frame-size must be a power of two >= 4/,
		);
	});

	it("accepts a frame size of 4", async () => {
		const inputPath = join(workingDirectory, "frame4.wav");
		const outputPath = join(workingDirectory, "frame4-out.wav");

		await writeWav(inputPath, [new Float64Array(64).fill(0.2)]);
		await capture(async () => {
			await parseProgram(["crest", inputPath, "-o", outputPath, "--frame-size", "4"]);
		});

		expect(existsSync(outputPath)).toBe(true);
	});

	it("preserves the magnitude spectrum of a multitone within tolerance", async () => {
		const inputPath = join(workingDirectory, "tone.wav");
		const outputPath = join(workingDirectory, "tone-out.wav");
		const frameSize = 2048;

		await writeWav(inputPath, [makeMultitone(SAMPLE_RATE)]);
		await capture(() => crest(inputPath, { output: outputPath }));

		const input = await readChannel(inputPath);
		const output = await readChannel(outputPath);
		const inputSpectrum = welchMagnitude(input.subarray(LATTICE_ORDER), frameSize);
		const outputSpectrum = welchMagnitude(output.subarray(LATTICE_ORDER), frameSize);
		let weightedError = 0;
		let weight = 0;

		for (let bin = 1; bin < inputSpectrum.length; bin++) {
			const expected = inputSpectrum[bin] ?? 0;

			if (expected < 1e-4) {
				continue;
			}

			weightedError += Math.abs((outputSpectrum[bin] ?? 0) - expected) / expected;
			weight += 1;
		}

		expect(weight).toBeGreaterThan(0);
		expect(weightedError / weight).toBeLessThan(0.08);

		let inputEnergy = 0;
		let outputEnergy = 0;

		for (let index = 4000; index < input.length - 4000; index++) {
			inputEnergy += (input[index] ?? 0) * (input[index] ?? 0);
			outputEnergy += (output[index] ?? 0) * (output[index] ?? 0);
		}

		const ratio = Math.sqrt(outputEnergy / inputEnergy);

		expect(ratio).toBeGreaterThan(0.99);
		expect(ratio).toBeLessThan(1.01);
	});

	it("reduces true peak on a high-crest impulse train", async () => {
		const inputPath = join(workingDirectory, "impulses.wav");
		const outputPath = join(workingDirectory, "impulses-out.wav");

		await writeWav(inputPath, [makeHeadroomBearing(SAMPLE_RATE)]);

		const { stdout } = await capture(() => crest(inputPath, { output: outputPath }));
		const sourceTp = await measureTruePeakDb(inputPath);
		const outputTp = await measureTruePeakDb(outputPath);

		expect(outputTp).toBeLessThan(sourceTp - 0.5);
		expect(stdout).toMatch(/source true peak/);
		expect(stdout).toMatch(/output true peak/);
		expect(stdout).toMatch(/delta/);
		expect(stdout).toContain(outputPath);
	});

	it("is approximately identity on already-diffuse noise", async () => {
		const inputPath = join(workingDirectory, "noise.wav");
		const outputPath = join(workingDirectory, "noise-out.wav");

		await writeWav(inputPath, createNoise(SAMPLE_RATE, 1, 7));
		await capture(() => crest(inputPath, { output: outputPath }));

		const input = await readChannel(inputPath);
		const output = await readChannel(outputPath);
		const sourceTp = await measureTruePeakDb(inputPath);
		const outputTp = await measureTruePeakDb(outputPath);

		expect(Math.abs(outputTp - sourceTp)).toBeLessThan(0.05);

		for (let index = LATTICE_ORDER; index < input.length; index++) {
			expect(output[index]).toBeCloseTo(input[index - LATTICE_ORDER] ?? Number.NaN, 5);
		}
	});

	it("is deterministic end to end", async () => {
		const inputPath = join(workingDirectory, "det.wav");
		const outputPath = join(workingDirectory, "det-out.wav");
		const outputPath2 = join(workingDirectory, "det-out2.wav");

		await writeWav(inputPath, [makeImpulses(1, 8, -6, -40)]);
		await capture(() => crest(inputPath, { output: outputPath }));
		await capture(() => crest(inputPath, { output: outputPath2 }));

		expect(Buffer.compare(await readFile(outputPath), await readFile(outputPath2))).toBe(0);
	});

	it("supports in-place -o <input>", async () => {
		const inputPath = join(workingDirectory, "inplace.wav");

		await writeWav(inputPath, [makeImpulses(1, 8, -6, -40)]);

		const sourceTp = await measureTruePeakDb(inputPath);

		await capture(() => crest(inputPath, { output: inputPath }));

		expect(await measureTruePeakDb(inputPath)).toBeLessThanOrEqual(sourceTp + 1e-6);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
		expect(existsSync(inputPath)).toBe(true);
	});

	it("passes a short file through unchanged", async () => {
		const inputPath = join(workingDirectory, "short.wav");
		const outputPath = join(workingDirectory, "short-out.wav");
		const samples = new Float64Array(64).fill(0.2);

		await writeWav(inputPath, [samples]);
		await capture(() => crest(inputPath, { output: outputPath }));

		expect(Buffer.compare(await readFile(inputPath), await readFile(outputPath))).toBe(0);
	});
});
