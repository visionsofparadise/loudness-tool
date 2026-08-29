import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli";
import { WavReader, type AudioBlock } from "../wav/WavReader";
import { WavWriter } from "../wav/WavWriter";
import { createNoise, createSine } from "../wav/utils/testSignals";
import { type WavBitDepth } from "../wav/utils/wavFormat";
import { convert } from "./convert";

const SAMPLE_RATE = 48000;

const quantizationBoundOf = (bitDepth: WavBitDepth): number => {
	switch (bitDepth) {
		case "16":
			return 1.5 / 0x8000;
		case "24":
			return 1.5 / 0x800000;
		case "32":
			return 1.5 / 0x80000000;
		case "32f":
			return 0;
	}
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

const readAll = async (path: string): Promise<{ format: WavReader["format"]; channels: Array<Float64Array> }> => {
	const reader = await WavReader.open(path);
	const blocks: Array<AudioBlock> = [];

	for await (const block of reader.blocks()) {
		blocks.push(block);
	}

	await reader.close();

	return { format: reader.format, channels: mergeBlocks(blocks) };
};

const expectChannelsMatch = (
	actual: Array<Float64Array>,
	expected: ReadonlyArray<Float64Array>,
	bitDepth: WavBitDepth,
): void => {
	expect(actual.length).toBe(expected.length);

	const bound = quantizationBoundOf(bitDepth);

	for (let channelIndex = 0; channelIndex < expected.length; channelIndex++) {
		const actualChannel = actual[channelIndex];
		const expectedChannel = expected[channelIndex];

		expect(actualChannel?.length).toBe(expectedChannel?.length);

		for (let frameIndex = 0; frameIndex < (expectedChannel?.length ?? 0); frameIndex++) {
			const actualSample = actualChannel?.[frameIndex] ?? 0;
			const expectedSample = expectedChannel?.[frameIndex] ?? 0;

			if (bitDepth === "32f") {
				expect(actualSample).toBe(Math.fround(expectedSample));
			} else {
				expect(Math.abs(actualSample - expectedSample)).toBeLessThanOrEqual(bound);
			}
		}
	}
};

const writeWav = async (path: string, bitDepth: WavBitDepth, channels: Array<Float64Array>): Promise<void> => {
	const writer = await WavWriter.create(path, {
		sampleRate: SAMPLE_RATE,
		channelCount: channels.length,
		bitDepth,
	});

	await writer.write(channels);
	await writer.close();
};

const summaryLineOf = (
	inputPath: string,
	channelCount: number,
	sourceBitDepth: string,
	frameCount: number,
	outputPath: string,
	outputBitDepth: WavBitDepth,
): string =>
	`${inputPath}: ${SAMPLE_RATE} Hz, ${channelCount} ch, ${sourceBitDepth}, ${(frameCount / SAMPLE_RATE).toFixed(3)} s -> ${outputPath}: ${outputBitDepth}`;

const temporaryNamesOf = async (directory: string): Promise<Array<string>> => {
	const names = await readdir(directory);

	return names.filter((name) => name.endsWith(".tmp"));
};

describe("convert", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-convert-"));
		vi.spyOn(console, "log").mockImplementation(() => undefined);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it.each(["16", "24", "32", "32f"] as const)("passthrough preserves %s content", async (bitDepth) => {
		const inputPath = join(workingDirectory, `in-${bitDepth}.wav`);
		const outputPath = join(workingDirectory, `out-${bitDepth}.wav`);
		const channels = createNoise(256, 2, 11);
		const frameCount = 256;

		await writeWav(inputPath, bitDepth, channels);

		const source = await readAll(inputPath);

		await convert(inputPath, { output: outputPath });

		const read = await readAll(outputPath);

		expect(read.format.sampleRate).toBe(SAMPLE_RATE);
		expect(read.format.channelCount).toBe(2);
		expect(read.format.bitDepth).toBe(bitDepth);
		expect(read.format.frameCount).toBe(frameCount);
		expectChannelsMatch(read.channels, source.channels, bitDepth);
		expect(console.log).toHaveBeenCalledWith(summaryLineOf(inputPath, 2, bitDepth, frameCount, outputPath, bitDepth));
	});

	it("converts 32f source to 16 within quantization", async () => {
		const inputPath = join(workingDirectory, "in-32f.wav");
		const outputPath = join(workingDirectory, "out-16.wav");
		const channels = createSine(480, 1, SAMPLE_RATE, 440);
		const frameCount = 480;

		await writeWav(inputPath, "32f", channels);
		await convert(inputPath, { output: outputPath, bitDepth: "16" });

		const read = await readAll(outputPath);

		expect(read.format.bitDepth).toBe("16");
		expect(read.format.sampleRate).toBe(SAMPLE_RATE);
		expect(read.format.channelCount).toBe(1);
		expect(read.format.frameCount).toBe(frameCount);
		expectChannelsMatch(read.channels, channels, "16");
		expect(console.log).toHaveBeenCalledWith(summaryLineOf(inputPath, 1, "32f", frameCount, outputPath, "16"));
	});

	it("supports in-place -o <input>", async () => {
		const inputPath = join(workingDirectory, "inplace.wav");
		const channels = createSine(128, 2, SAMPLE_RATE, 220);
		const frameCount = 128;

		await writeWav(inputPath, "32f", channels);
		await convert(inputPath, { output: inputPath });

		const read = await readAll(inputPath);

		expect(read.format.bitDepth).toBe("32f");
		expectChannelsMatch(read.channels, channels, "32f");
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);
		expect(console.log).toHaveBeenCalledWith(summaryLineOf(inputPath, 2, "32f", frameCount, inputPath, "32f"));
	});

	it("leaves the destination untouched when a write fails", async () => {
		const inputPath = join(workingDirectory, "source.wav");
		const outputPath = join(workingDirectory, "dest.wav");
		const sourceChannels = createSine(64, 1, SAMPLE_RATE, 440);
		const existingChannels = createNoise(64, 1, 7);

		await writeWav(inputPath, "32f", sourceChannels);
		await writeWav(outputPath, "32f", existingChannels);

		const writeThrough = WavWriter.prototype.write;

		vi.spyOn(WavWriter.prototype, "write").mockImplementation(async function (
			this: WavWriter,
			channels: ReadonlyArray<Float64Array>,
		): Promise<void> {
			await writeThrough.call(this, channels);
			throw new Error("injected write failure");
		});

		await expect(convert(inputPath, { output: outputPath })).rejects.toThrow("injected write failure");

		expect(existsSync(outputPath)).toBe(true);
		expect(await temporaryNamesOf(workingDirectory)).toEqual([]);

		const read = await readAll(outputPath);

		expectChannelsMatch(read.channels, existingChannels, "32f");
		expect(console.log).not.toHaveBeenCalled();
	});

	it("rejects an unknown --bit-depth via the choices declaration", async () => {
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

		await expect(
			program.parseAsync(["convert", "in.wav", "-o", "out.wav", "--bit-depth", "8"], { from: "user" }),
		).rejects.toThrow(/Allowed choices are 16, 24, 32, 32f/);
	});
});
