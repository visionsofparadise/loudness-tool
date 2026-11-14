import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePlanar } from "../../utils/testWav";
import { BLOCK_FRAMES } from "../../wav/WavReader";
import { WavWriter } from "../../wav/WavWriter";
import { withAudioInput } from "./AudioInput";
import { DEFAULT_STREAM_OPTIONS, type StreamOptions } from "./streamOptions";
import type { SourceBitDepth } from "../../wav/utils/wavFormat";

const SAMPLE_RATE = 48000;
const FRAME_COUNT = BLOCK_FRAMES + 1000;

const channelsWith = (channelIndex: number, frameIndex: number, sample: number): Array<Float64Array> => {
	const channels = [new Float64Array(FRAME_COUNT).fill(0.25), new Float64Array(FRAME_COUNT).fill(-0.25)];
	const channel = channels[channelIndex];

	if (channel !== undefined) {
		channel[frameIndex] = sample;
	}

	return channels;
};

const writeWav = async (path: string, channels: Array<Float64Array>, bitDepth: SourceBitDepth): Promise<void> => {
	const writer = await WavWriter.create(
		{ kind: "file", path },
		{ sampleRate: SAMPLE_RATE, channelCount: channels.length, channelMask: 0, bitDepth, frameCount: FRAME_COUNT },
	);

	await writer.write(channels);
	await writer.close();
};

const readThrough = async (path: string, stream: StreamOptions = DEFAULT_STREAM_OPTIONS): Promise<void> => {
	await withAudioInput(
		path,
		{ replayable: false, scratchDirectory: undefined, stream, output: undefined },
		async (input) =>
			input.withFirstPass(async (source) => {
				for await (const block of source.blocks()) {
					expect(block.channels.length).toBe(2);
				}
			}),
	);
};

describe("AudioInput's first pass over a float input", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-finite-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it.each([
		["32f", 0, 120, Number.NaN],
		["64f", 1, BLOCK_FRAMES + 500, Number.NEGATIVE_INFINITY],
		["32f", 1, FRAME_COUNT - 1, Number.POSITIVE_INFINITY],
	] as const)("fails a %s WAV naming channel %i, frame %i", async (bitDepth, channelIndex, frameIndex, sample) => {
		const path = join(workingDirectory, "bad.wav");

		await writeWav(path, channelsWith(channelIndex, frameIndex, sample), bitDepth);

		await expect(readThrough(path)).rejects.toThrow(
			`"${path}" holds a sample that is not a finite number at frame ${frameIndex}, channel ${channelIndex}`,
		);
	});

	it("fails a raw f32le input past its first block", async () => {
		const path = join(workingDirectory, "bad.raw");
		const frameIndex = BLOCK_FRAMES + 7;

		await writeFile(path, encodePlanar(channelsWith(0, frameIndex, Number.NaN), "32f"));

		await expect(
			readThrough(path, { ...DEFAULT_STREAM_OPTIONS, format: "f32le", sampleRate: SAMPLE_RATE, channelCount: 2 }),
		).rejects.toThrow(`"${path}" holds a sample that is not a finite number at frame ${frameIndex}, channel 0`);
	});

	it("fails a 64f WAV on stdin past its first block", async () => {
		const path = join(workingDirectory, "bad.wav");
		const frameIndex = BLOCK_FRAMES + 3;
		const stdin = new PassThrough();

		await writeWav(path, channelsWith(1, frameIndex, Number.NaN), "64f");
		stdin.end(await readFile(path));
		vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);

		try {
			await expect(readThrough("-")).rejects.toThrow(
				`"-" holds a sample that is not a finite number at frame ${frameIndex}, channel 1`,
			);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("reads a finite float input to its end", async () => {
		const path = join(workingDirectory, "good.wav");

		await writeWav(path, channelsWith(0, 0, 1), "32f");

		await expect(readThrough(path)).resolves.toBeUndefined();
	});
});
