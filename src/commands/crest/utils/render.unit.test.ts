import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNoise } from "../../../utils/testSignals";
import { WavWriter } from "../../../wav/WavWriter";
import { dispersionKernelOf } from "./dispersion";
import { crestLayoutOf, type CrestLayout } from "./layout";
import { forEachStretchChunk, type StretchChunk } from "./render";

const SAMPLE_RATE = 48000;

const everyChunk = async (path: string, layout: CrestLayout, handle: (chunk: StretchChunk) => void): Promise<void> => {
	await forEachStretchChunk({
		path,
		layout,
		ranges: [{ firstStretch: 0, lastStretch: layout.stretchCount - 1 }],
		stepIndicesOf: () => layout.steps.map((_step, stepIndex) => stepIndex),
		handle,
	});
};

const floatNoise = (frameCount: number, channelCount: number, seed: number): Array<Float64Array> =>
	createNoise(frameCount, channelCount, seed).map((channel) => Float64Array.from(channel, Math.fround));

const dispersedAt = (channel: Float64Array, frame: number, step: number): number => {
	const kernel = dispersionKernelOf(step);
	const halfWidth = (kernel.length - 1) / 2;
	let sum = 0;

	for (let tap = -halfWidth; tap <= halfWidth; tap++) {
		const index = frame - tap;

		if (index >= 0 && index < channel.length) {
			sum += (kernel[tap + halfWidth] ?? 0) * (channel[index] ?? 0);
		}
	}

	return sum;
};

describe("forEachStretchChunk", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-crest-render-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const writeSource = async (channels: Array<Float64Array>): Promise<string> => {
		const path = join(workingDirectory, "source.wav");
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

		return path;
	};

	const collect = async (
		path: string,
		layout: CrestLayout,
	): Promise<{ dispersed: Array<Array<Float64Array>>; chunks: Array<StretchChunk> }> => {
		const dispersed = layout.steps.map(() => [new Float64Array(layout.frameCount)]);
		const chunks: Array<StretchChunk> = [];

		await everyChunk(path, layout, (chunk) => {
			chunks.push({ ...chunk, dispersed: [] });

			const frameCount = Math.min(layout.frameCount - chunk.firstFrame, chunk.stretchCount * layout.stretchFrames);

			for (let stepIndex = 0; stepIndex < layout.steps.length; stepIndex++) {
				dispersed[stepIndex]?.[0]?.set(
					chunk.dispersed[stepIndex]?.[0]?.subarray(0, frameCount) ?? new Float64Array(0),
					chunk.firstFrame,
				);
			}
		});

		return { dispersed, chunks };
	};

	it("disperses the source by every step with silence beyond its ends", async () => {
		const frameCount = 40000;
		const channels = floatNoise(frameCount, 1, 13);
		const path = await writeSource(channels);
		const layout = crestLayoutOf({ spreadMs: 0.1, steps: 2, smoothingMs: 0.5, sampleRate: SAMPLE_RATE, frameCount });
		const { dispersed, chunks } = await collect(path, layout);
		const source = channels[0] ?? new Float64Array(0);

		expect(chunks.length).toBeGreaterThan(1);

		for (let stepIndex = 0; stepIndex < layout.steps.length; stepIndex++) {
			const step = layout.steps[stepIndex] ?? 0;

			for (const frame of [0, 1, 4, 16379, 16380, 16381, 32760, 39998, 39999]) {
				expect(dispersed[stepIndex]?.[0]?.[frame] ?? 0).toBeCloseTo(dispersedAt(source, frame, step), 12);
			}
		}
	});

	it("disperses a file's last chunk alone as it does after its predecessor", async () => {
		const frameCount = 40000;
		const path = await writeSource(floatNoise(frameCount, 2, 17));
		const layout = crestLayoutOf({ spreadMs: 0.1, steps: 2, smoothingMs: 0.5, sampleRate: SAMPLE_RATE, frameCount });
		const firstStretches: Array<number> = [];

		await everyChunk(path, layout, (chunk) => {
			firstStretches.push(chunk.firstStretch);
		});

		const lastChunkOf = async (firstStretch: number): Promise<Array<Array<Array<number>>>> => {
			let last: Array<Array<Array<number>>> = [];

			await forEachStretchChunk({
				path,
				layout,
				ranges: [{ firstStretch, lastStretch: layout.stretchCount - 1 }],
				stepIndicesOf: () => layout.steps.map((_step, stepIndex) => stepIndex),
				handle: (chunk) => {
					const chunkFrames = layout.frameCount - chunk.firstFrame;

					last = chunk.dispersed.map((channels) =>
						channels.map((channel) => Array.from(channel.subarray(0, chunkFrames))),
					);
				},
			});

			return last;
		};

		expect(firstStretches.length).toBeGreaterThan(2);

		const alone = await lastChunkOf(firstStretches[firstStretches.length - 1] ?? 0);
		const afterPredecessor = await lastChunkOf(firstStretches[firstStretches.length - 2] ?? 0);

		expect(alone).toEqual(afterPredecessor);
	});

	it("disperses a middle chunk alone as it does within a call over three consecutive chunks", async () => {
		const frameCount = 40000;
		const path = await writeSource(floatNoise(frameCount, 2, 23));
		const layout = crestLayoutOf({ spreadMs: 0.1, steps: 2, smoothingMs: 0.5, sampleRate: SAMPLE_RATE, frameCount });
		const firstStretches: Array<number> = [];

		await everyChunk(path, layout, (chunk) => {
			firstStretches.push(chunk.firstStretch);
		});

		const middleStretch = firstStretches[1] ?? 0;
		const middleOf = async (range: {
			firstStretch: number;
			lastStretch: number;
		}): Promise<Array<Array<Array<number>>>> => {
			let middle: Array<Array<Array<number>>> = [];

			await forEachStretchChunk({
				path,
				layout,
				ranges: [range],
				stepIndicesOf: () => layout.steps.map((_step, stepIndex) => stepIndex),
				handle: (chunk) => {
					if (chunk.firstStretch === middleStretch) {
						middle = chunk.dispersed.map((channels) => channels.map((channel) => Array.from(channel)));
					}
				},
			});

			return middle;
		};

		expect(firstStretches.length).toBe(3);

		const alone = await middleOf({ firstStretch: middleStretch, lastStretch: (firstStretches[2] ?? 0) - 1 });
		const within = await middleOf({ firstStretch: 0, lastStretch: layout.stretchCount - 1 });

		expect(alone.length).toBe(layout.steps.length);
		expect(alone).toEqual(within);
	});

	it("disperses only the steps it is asked for", async () => {
		const frameCount = 2000;
		const path = await writeSource(floatNoise(frameCount, 1, 29));
		const layout = crestLayoutOf({ spreadMs: 0.1, steps: 2, smoothingMs: 0.5, sampleRate: SAMPLE_RATE, frameCount });
		const touched: Array<boolean> = [];

		await forEachStretchChunk({
			path,
			layout,
			ranges: [{ firstStretch: 0, lastStretch: layout.stretchCount - 1 }],
			stepIndicesOf: () => [1],
			handle: (chunk) => {
				for (const [stepIndex, channels] of chunk.dispersed.entries()) {
					touched[stepIndex] =
						(touched[stepIndex] ?? false) || channels.some((channel) => channel.some((sample) => sample !== 0));
				}
			},
		});

		expect(touched).toEqual([false, true, false, false]);
	});
});
