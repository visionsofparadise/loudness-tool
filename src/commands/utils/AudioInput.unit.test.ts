import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoise } from "../../utils/testSignals";
import { decodedSamplesOf } from "../../utils/testCli";
import { BLOCK_FRAMES, type AudioBlock } from "../../wav/WavReader";
import { WavWriter } from "../../wav/WavWriter";
import { AudioInput, withAudioInput } from "./AudioInput";

const SAMPLE_RATE = 48000;

const writeWav = async (path: string, channels: Array<Float64Array>): Promise<void> => {
	const writer = await WavWriter.create(
		{ kind: "file", path },
		{
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			channelMask: 0,
			bitDepth: "24",
			frameCount: channels[0]?.length ?? 0,
		},
	);

	await writer.write(channels);
	await writer.close();
};

const spyStdin = (bytes: Buffer): PassThrough => {
	const stream = new PassThrough();

	vi.spyOn(process, "stdin", "get").mockReturnValue(stream as unknown as typeof process.stdin);
	stream.end(bytes);

	return stream;
};

const collect = async (blocks: AsyncIterableIterator<AudioBlock>): Promise<number> => {
	let frameCount = 0;

	for await (const block of blocks) {
		frameCount += block.channels[0]?.length ?? 0;
	}

	return frameCount;
};

describe("AudioInput", () => {
	let workingDirectory: string;
	let inputPath: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-audio-input-"));
		inputPath = join(workingDirectory, "input.wav");

		await writeWav(inputPath, createNoise(BLOCK_FRAMES + 100, 2, 3));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("replays a file input from its own path once its first pass has run", async () => {
		const scratchDirectory = join(workingDirectory, "scratch");

		await withAudioInput(inputPath, { replayable: true, scratchDirectory }, async (input) => {
			expect(input.label).toBe(inputPath);
			expect(() => input.replayPath()).toThrow(/no replay/);
			expect(await input.withFirstPass(async (source) => collect(source.blocks()))).toBe(BLOCK_FRAMES + 100);
			expect(input.replayPath()).toBe(inputPath);
			await expect(input.withFirstPass(async () => 0)).rejects.toThrow(/already run/);
		});

		expect(existsSync(scratchDirectory)).toBe(false);
	});

	it("spools stdin into the scratch directory during the first pass and removes it on dispose", async () => {
		const scratchDirectory = join(workingDirectory, "scratch");

		spyStdin(await readFile(inputPath));

		await withAudioInput("-", { replayable: true, scratchDirectory }, async (input) => {
			expect(input.label).toBe("-");
			expect(() => input.replayPath()).toThrow(/no replay/);
			expect(await input.withFirstPass(async (source) => collect(source.blocks()))).toBe(BLOCK_FRAMES + 100);

			const replayPath = input.replayPath();

			expect(replayPath.startsWith(join(scratchDirectory, `loudness-tool-${process.pid}-`))).toBe(true);
			expect(replayPath.endsWith("input.wav")).toBe(true);
			expect(await decodedSamplesOf(replayPath)).toEqual(await decodedSamplesOf(inputPath));
		});

		expect(await readdir(scratchDirectory)).toEqual([]);
	});

	it("reads stdin without a spool or a scratch directory when not replayable", async () => {
		const scratchDirectory = join(workingDirectory, "scratch");

		spyStdin(await readFile(inputPath));

		await withAudioInput("-", { replayable: false, scratchDirectory }, async (input) => {
			expect(await input.withFirstPass(async (source) => collect(source.blocks()))).toBe(BLOCK_FRAMES + 100);
			expect(() => input.replayPath()).toThrow(/no replay/);
		});

		expect(existsSync(scratchDirectory)).toBe(false);
	});

	it("has no replay when the first pass stops before the end of stdin", async () => {
		const scratchDirectory = join(workingDirectory, "scratch");
		const stream = spyStdin(await readFile(inputPath));
		const input = await AudioInput.of("-", { replayable: true, scratchDirectory });

		try {
			await expect(
				input.withFirstPass(async (source) => {
					for await (const _block of source.blocks()) {
						throw new Error("consumer failed");
					}
				}),
			).rejects.toThrow("consumer failed");
			expect(() => input.replayPath()).toThrow(/no replay/);
			expect(stream.destroyed).toBe(true);
		} finally {
			await input.dispose();
		}

		expect(await readdir(scratchDirectory)).toEqual([]);
	});
});
