import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../cli";
import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { createNoise, createSine } from "../../utils/testSignals";
import { WavReader, type AudioBlock } from "../../wav/WavReader";
import { WavWriter } from "../../wav/WavWriter";
import { printedDbOf, quantizerOf } from "./utils/rounding";
import { crest } from "./index";
import type { WavBitDepth } from "../../wav/utils/wavFormat";

const SAMPLE_RATE = 48000;

const peakySource = (frameCount: number, channelCount: number, seed: number): Array<Float64Array> => {
	const channels = createNoise(frameCount, channelCount, seed).map((channel) =>
		Float64Array.from(channel, (sample) => Math.fround(sample * 0.05)),
	);

	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		const channel = channels[channelIndex];

		for (let offset = 0; offset < 24; offset++) {
			const position = 300 + channelIndex * 120 + offset;

			if (channel !== undefined && position < frameCount) {
				channel[position] = Math.fround(
					0.85 * Math.exp(-offset / 4) * Math.sin((2 * Math.PI * 1200 * offset) / SAMPLE_RATE + 1),
				);
			}
		}
	}

	return channels;
};

const writeWav = async (path: string, channels: Array<Float64Array>, bitDepth: WavBitDepth): Promise<void> => {
	const writer = await WavWriter.create(
		{ kind: "file", path },
		{
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			channelMask: 0,
			bitDepth,
			frameCount: channels[0]?.length ?? 0,
		},
	);

	await writer.write(channels);
	await writer.close();
};

const readAll = async (path: string): Promise<{ channels: Array<Float64Array>; bitDepth: WavBitDepth }> => {
	const reader = await WavReader.open(path);
	const channels: Array<Float64Array> = [];

	for (let channelIndex = 0; channelIndex < reader.format.channelCount; channelIndex++) {
		channels.push(new Float64Array(reader.format.frameCount));
	}

	for await (const block of reader.blocks()) {
		for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
			channels[channelIndex]?.set(block.channels[channelIndex] ?? new Float64Array(0), block.frameIndex);
		}
	}

	const bitDepth = reader.format.bitDepth as WavBitDepth;

	await reader.close();

	return { channels, bitDepth };
};

const truePeakOf = async (path: string): Promise<number> => {
	const { channels } = await readAll(path);
	const accumulator = new TruePeakAccumulator(channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return accumulator.finalize();
};

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

const parseProgram = async (argv: Array<string>): Promise<unknown> => {
	const program = createProgram();
	const silence = { writeOut: () => undefined, writeErr: () => undefined };

	program.exitOverride();
	program.configureOutput(silence);

	for (const command of program.commands) {
		command.exitOverride();
		command.configureOutput(silence);
	}

	return program.parseAsync(argv, { from: "user" });
};

const temporaryNamesOf = async (directory: string): Promise<Array<string>> =>
	(await readdir(directory)).filter((name) => name.endsWith(".tmp"));

const mockBlockFrames = (blockFrames: number): void => {
	const original = WavReader.prototype.blocks;

	vi.spyOn(WavReader.prototype, "blocks").mockImplementation(function (this: WavReader) {
		const reader = this;

		return (async function* (): AsyncIterableIterator<AudioBlock> {
			for await (const block of original.call(reader)) {
				const frameCount = block.channels[0]?.length ?? 0;

				for (let offset = 0; offset < frameCount; offset += blockFrames) {
					const take = Math.min(blockFrames, frameCount - offset);

					yield {
						channels: block.channels.map((channel) => channel.slice(offset, offset + take)),
						frameIndex: block.frameIndex + offset,
					};
				}
			}
		})();
	});
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

	it("lowers the true peak and reports source, output, and delta", async () => {
		const inputPath = join(workingDirectory, "in.wav");
		const outputPath = join(workingDirectory, "out.wav");

		await writeWav(inputPath, peakySource(900, 1, 9), "32f");

		const sourcePeak = printedDbOf(await truePeakOf(inputPath));
		const stdout = await captureStdout(() => crest(inputPath, { output: outputPath, spread: 0.25, smoothing: 2 }));
		const outputPeak = printedDbOf(await truePeakOf(outputPath));

		expect(stdout).toBe(
			[
				`source true peak    ${sourcePeak.toFixed(2)} dBTP`,
				`output true peak    ${outputPeak.toFixed(2)} dBTP`,
				`delta               ${(outputPeak - sourcePeak).toFixed(2)} dB`,
				`output              ${outputPath}`,
				"",
			].join("\n"),
		);
		expect(outputPeak).toBeLessThan(sourcePeak);
	});

	it("reports the source true peak of the raw samples, not of the quantized frames it meters", async () => {
		const inputPath = join(workingDirectory, "full-scale.wav");
		const outputPath = join(workingDirectory, "full-scale-out.wav");
		const channel = Float64Array.from({ length: 400 }, (_sample, index) =>
			index % 2 === 0 ? 32763 / 0x7fff : 16382 / 0x7fff,
		);

		await writeWav(inputPath, [channel], "16");

		const { channels } = await readAll(inputPath);
		const quantize = quantizerOf("16");
		const quantized = (channels[0] ?? new Float64Array(0)).map(quantize);
		const quantizedAccumulator = new TruePeakAccumulator(1);

		quantizedAccumulator.push([quantized], quantized.length);

		const rawDb = printedDbOf(await truePeakOf(inputPath));
		const quantizedDb = printedDbOf(quantizedAccumulator.finalize());
		const stdout = await captureStdout(() => crest(inputPath, { output: outputPath, spread: 0.25, smoothing: 2 }));

		expect(rawDb).not.toBe(quantizedDb);
		expect(stdout).toContain(`source true peak    ${rawDb.toFixed(2)} dBTP`);
	});

	it("preserves the frame count, sample rate, channel count, and writable bit depth", async () => {
		const inputPath = join(workingDirectory, "stereo.wav");
		const outputPath = join(workingDirectory, "stereo-out.wav");

		await writeWav(inputPath, peakySource(600, 2, 17), "16");
		await captureStdout(() => crest(inputPath, { output: outputPath, spread: 0.25, smoothing: 2 }));

		const reader = await WavReader.open(outputPath);

		expect(reader.format).toEqual({
			sampleRate: SAMPLE_RATE,
			channelCount: 2,
			channelMask: 0,
			bitDepth: "16",
			frameCount: 600,
		});

		await reader.close();
	});

	it("produces the same bytes whatever the block size the source is read in", async () => {
		const inputPath = join(workingDirectory, "blocks.wav");
		const wholePath = join(workingDirectory, "whole.wav");
		const splitPath = join(workingDirectory, "split.wav");

		await writeWav(inputPath, peakySource(700, 1, 23), "32f");
		await captureStdout(() => crest(inputPath, { output: wholePath, spread: 0.25, smoothing: 2 }));

		mockBlockFrames(13);

		await captureStdout(() => crest(inputPath, { output: splitPath, spread: 0.25, smoothing: 2 }));

		expect(await readFile(splitPath)).toEqual(await readFile(wholePath));
	});

	it("supports an output that is the input path", async () => {
		const inputPath = join(workingDirectory, "inplace.wav");
		const referencePath = join(workingDirectory, "reference.wav");
		const expectedPath = join(workingDirectory, "expected.wav");
		const channels = peakySource(600, 1, 29);

		await writeWav(
			inputPath,
			channels.map((channel) => Float64Array.from(channel)),
			"32f",
		);
		await writeWav(
			referencePath,
			channels.map((channel) => Float64Array.from(channel)),
			"32f",
		);
		await captureStdout(() => crest(referencePath, { output: expectedPath, spread: 0.25, smoothing: 2 }));
		await captureStdout(() => crest(inputPath, { output: inputPath, spread: 0.25, smoothing: 2 }));

		expect(await readFile(inputPath)).toEqual(await readFile(expectedPath));
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("leaves a silent source alone", async () => {
		const inputPath = join(workingDirectory, "silence.wav");
		const outputPath = join(workingDirectory, "silence-out.wav");

		await writeWav(inputPath, [new Float64Array(400)], "32f");

		const stdout = await captureStdout(() => crest(inputPath, { output: outputPath }));
		const { channels } = await readAll(outputPath);

		expect(stdout).toContain("source true peak    -200.00 dBTP");
		expect(stdout).toContain("output true peak    -200.00 dBTP");
		expect(stdout).toContain("delta               0.00 dB");
		expect(Array.from(channels[0] ?? [])).toEqual(Array.from(new Float64Array(400)));
	});

	it("writes an empty output for a source with no frames", async () => {
		const inputPath = join(workingDirectory, "empty.wav");
		const outputPath = join(workingDirectory, "empty-out.wav");

		await writeWav(inputPath, [new Float64Array(0)], "32f");

		const stdout = await captureStdout(() => crest(inputPath, { output: outputPath }));
		const reader = await WavReader.open(outputPath);

		expect(reader.format.frameCount).toBe(0);
		expect(stdout).toContain("output true peak    -200.00 dBTP");

		await reader.close();
	});

	it("rejects a spread outside (0, 50] and a smoothing that is not above zero", async () => {
		await expect(parseProgram(["crest", "in.wav", "-o", "out.wav", "--spread", "0"])).rejects.toThrow(
			/spread must be in \(0, 50\]/,
		);
		await expect(parseProgram(["crest", "in.wav", "-o", "out.wav", "--spread", "51"])).rejects.toThrow(
			/spread must be in \(0, 50\]/,
		);
		await expect(parseProgram(["crest", "in.wav", "-o", "out.wav", "--spread", "wide"])).rejects.toThrow(
			/spread must be in \(0, 50\]/,
		);
		await expect(parseProgram(["crest", "in.wav", "-o", "out.wav", "--smoothing", "0"])).rejects.toThrow(
			/smoothing must be > 0/,
		);
		await expect(parseProgram(["crest", "in.wav", "-o", "out.wav", "--smoothing", "-1"])).rejects.toThrow(
			/smoothing must be > 0/,
		);
	});

	it("requires an output path and accepts -o as its alias", async () => {
		await expect(parseProgram(["crest", "in.wav"])).rejects.toThrow(/--output/);
		expect(
			createProgram()
				.commands.find((command) => command.name() === "crest")
				?.options.some((option) => option.short === "-o" && option.long === "--output"),
		).toBe(true);
	});

	it("leaves the destination as it was when the run fails", async () => {
		const inputPath = join(workingDirectory, "source.wav");
		const outputPath = join(workingDirectory, "dest.wav");

		await writeWav(inputPath, peakySource(400, 1, 41), "32f");
		await writeWav(outputPath, createSine(64, 1, SAMPLE_RATE, 220, 0.2), "32f");

		const original = await readFile(outputPath);
		const writeThrough = WavWriter.prototype.write;

		vi.spyOn(WavWriter.prototype, "write").mockImplementation(async function (
			this: WavWriter,
			channels: ReadonlyArray<Float64Array>,
		): Promise<void> {
			await writeThrough.call(this, channels);

			throw new Error("injected write failure");
		});

		await expect(crest(inputPath, { output: outputPath, spread: 0.25, smoothing: 2 })).rejects.toThrow(
			"injected write failure",
		);

		expect(existsSync(outputPath)).toBe(true);
		expect(await readFile(outputPath)).toEqual(original);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
	});

	it("leaves the destination as it was when the source cannot be read", async () => {
		const outputPath = join(workingDirectory, "kept.wav");

		await writeWav(outputPath, createSine(64, 1, SAMPLE_RATE, 220, 0.2), "32f");

		const original = await readFile(outputPath);

		await expect(crest(join(workingDirectory, "missing.wav"), { output: outputPath })).rejects.toThrow();
		expect(await readFile(outputPath)).toEqual(original);
	});
});
