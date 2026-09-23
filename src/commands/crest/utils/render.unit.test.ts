import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { createNoise } from "../../../utils/testSignals";
import { WavWriter } from "../../../wav/WavWriter";
import { dispersionKernelOf } from "./dispersion";
import { crestLayoutOf, type CrestLayout } from "./ladder";
import {
	allocateChannels,
	forEachStretchChunk,
	measureStretch,
	renderStretch,
	OVERSAMPLE_FACTOR,
	TRUE_PEAK_TAIL_FRAMES,
	type StretchChunk,
} from "./render";
import { quantizerOf } from "./rounding";

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
		const writer = await WavWriter.create(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			bitDepth: "32f",
		});

		await writer.write(channels);
		await writer.close();

		return path;
	};

	const collect = async (
		path: string,
		layout: CrestLayout,
	): Promise<{ dispersed: Array<Array<Float64Array>>; chunks: Array<StretchChunk> }> => {
		const dispersed = layout.steps.map(() => allocateChannels(1, layout.frameCount));
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
		const layout = crestLayoutOf({ spreadMs: 0.1, smoothingMs: 0.5, sampleRate: SAMPLE_RATE, frameCount });
		const { dispersed, chunks } = await collect(path, layout);
		const source = channels[0] ?? new Float64Array(0);

		expect(chunks.length).toBeGreaterThan(1);

		for (let stepIndex = 0; stepIndex < layout.steps.length; stepIndex++) {
			const step = layout.steps[stepIndex] ?? 0;

			for (const frame of [0, 1, 4, 16379, 16380, 16381, 32760, 39998, 39999]) {
				expect(dispersed[stepIndex]?.[0]?.[frame] ?? 0).toBeCloseTo(dispersedAt(source, frame, step), 12);
			}
		}

		expect(Array.from(dispersed[layout.zeroStepIndex]?.[0] ?? [])).toEqual(Array.from(source));
	});

	it("blends the two dispersed sources with weight j over n on the step it ends on", async () => {
		const channels = floatNoise(120, 1, 29);
		const path = await writeSource(channels);
		const layout = crestLayoutOf({
			spreadMs: 0.1,
			smoothingMs: 0.5,
			sampleRate: SAMPLE_RATE,
			frameCount: 120,
		});
		const quantize = quantizerOf("32f");
		const output = allocateChannels(1, layout.stretchFrames);
		const source = channels[0] ?? new Float64Array(0);
		let checked = 0;

		await everyChunk(path, layout, (chunk) => {
			for (let index = 0; index < chunk.stretchCount; index++) {
				const stretchIndex = chunk.firstStretch + index;

				renderStretch({ chunk, layout, stretchIndex, beginStepIndex: 0, endStepIndex: 1, quantize, output });

				const firstFrame = stretchIndex * layout.stretchFrames;

				for (let offset = 0; offset < layout.stretchFrames; offset++) {
					const weight = (offset + 1) / layout.stretchFrames;
					const expected =
						dispersedAt(source, firstFrame + offset, layout.steps[0] ?? 0) * (1 - weight) +
						dispersedAt(source, firstFrame + offset, layout.steps[1] ?? 0) * weight;

					expect(output[0]?.[offset] ?? 0).toBeCloseTo(expected, 6);
					checked++;
				}
			}
		});

		expect(checked).toBe(120);
	});

	it("leaves a stretch identical to the source on the zero step", async () => {
		const channels = floatNoise(48, 1, 31);
		const path = await writeSource(channels);
		const layout = crestLayoutOf({ spreadMs: 0.1, smoothingMs: 0.5, sampleRate: SAMPLE_RATE, frameCount: 48 });
		const quantize = quantizerOf("32f");
		const output = allocateChannels(1, layout.stretchFrames);

		await everyChunk(path, layout, (chunk) => {
			renderStretch({
				chunk,
				layout,
				stretchIndex: 0,
				beginStepIndex: layout.zeroStepIndex,
				endStepIndex: layout.zeroStepIndex,
				quantize,
				output,
			});
		});

		expect(Array.from(output[0]?.subarray(0, layout.stretchFrames) ?? [])).toEqual(
			Array.from(channels[0]?.subarray(0, layout.stretchFrames) ?? []),
		);
	});
});

describe("measureStretch", () => {
	it("covers every window the accumulator reads", () => {
		const channels = floatNoise(40, 2, 5);
		const frameCount = 40;
		const measure = measureStretch({
			output: channels,
			sourceFrames: channels,
			frameCount,
			scratch: new Float64Array(frameCount * OVERSAMPLE_FACTOR),
			tailScratch: new Float64Array(TRUE_PEAK_TAIL_FRAMES * OVERSAMPLE_FACTOR),
		});
		const accumulator = new TruePeakAccumulator(2);

		accumulator.push(channels, frameCount);

		let peak = measure.peak;

		for (const table of [measure.head, measure.carry]) {
			for (const value of table) {
				peak = Math.max(peak, Math.abs(value));
			}
		}

		expect(peak).toBeCloseTo(accumulator.finalize(), 12);
		expect(measure.identicalFrames).toBe(frameCount);
	});

	it("counts a frame as identical only when every channel matches", () => {
		const source = floatNoise(16, 2, 7);
		const output = source.map((channel) => Float64Array.from(channel));
		const altered = output[1];

		if (altered !== undefined) {
			altered[3] = (altered[3] ?? 0) + 0.5;
		}

		const measure = measureStretch({
			output,
			sourceFrames: source,
			frameCount: 16,
			scratch: new Float64Array(16 * OVERSAMPLE_FACTOR),
			tailScratch: new Float64Array(TRUE_PEAK_TAIL_FRAMES * OVERSAMPLE_FACTOR),
		});

		expect(measure.identicalFrames).toBe(15);
	});
});
