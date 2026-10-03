import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { WavReader } from "../../../wav/WavReader";
import { WavWriter } from "../../../wav/WavWriter";
import { applyWalk } from "./apply";
import { dispersionKernelOf } from "./dispersion";
import { crestLayoutOf, stretchFrameCountOf, type CrestLayout } from "./ladder";
import { printedDbOf, quantizerOf } from "./rounding";
import { solveCrest } from "./solve";
import { SourceMeter } from "./SourceMeter";
import type { WavBitDepth } from "../../../wav/utils/wavFormat";

const SAMPLE_RATE = 48000;

const quantize = quantizerOf("32f");

const peakySource = (frameCount: number, seed: number): Float64Array => {
	let state = seed >>> 0;
	const channel = new Float64Array(frameCount);

	for (let index = 0; index < frameCount; index++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		channel[index] = Math.fround((state / 0x80000000 - 1) * 0.05);
	}

	for (let position = 137; position + 24 < frameCount; position += 611) {
		for (let offset = 0; offset < 24; offset++) {
			channel[position + offset] = Math.fround(
				0.85 * Math.exp(-offset / 4) * Math.sin((2 * Math.PI * 1200 * offset) / SAMPLE_RATE + 1),
			);
		}
	}

	return channel;
};

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

const renderWalk = (channel: Float64Array, layout: CrestLayout, walk: Int32Array): Float64Array => {
	const output = new Float64Array(layout.frameCount);

	for (let stretchIndex = 0; stretchIndex < layout.stretchCount; stretchIndex++) {
		const begin = layout.steps[walk[stretchIndex] ?? 0] ?? 0;
		const end = layout.steps[walk[stretchIndex + 1] ?? 0] ?? 0;
		const firstFrame = stretchIndex * layout.stretchFrames;

		for (let offset = 0; offset < stretchFrameCountOf(layout, stretchIndex); offset++) {
			const frame = firstFrame + offset;
			const weight = (offset + 1) / layout.stretchFrames;

			output[frame] = quantize(
				begin === end
					? dispersedAt(channel, frame, begin)
					: dispersedAt(channel, frame, begin) * (1 - weight) + dispersedAt(channel, frame, end) * weight,
			);
		}
	}

	return output;
};

describe("applyWalk", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-crest-apply-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const readOutput = async (path: string): Promise<Float64Array> => {
		const reader = await WavReader.open(path);
		const channel = new Float64Array(reader.format.frameCount);

		for await (const block of reader.blocks()) {
			channel.set(block.channels[0] ?? new Float64Array(0), block.frameIndex);
		}

		await reader.close();

		return channel;
	};

	const solveAndApply = async (
		channel: Float64Array,
		spreadMs: number,
		smoothingMs: number,
		bitDepth: WavBitDepth = "32f",
	): Promise<{ layout: CrestLayout; walk: Int32Array; level: number; measured: number; written: Float64Array }> => {
		const inputPath = join(workingDirectory, "in.wav");
		const outputPath = join(workingDirectory, "out.wav");
		const writer = await WavWriter.create(
			{ kind: "file", path: inputPath },
			{
				sampleRate: SAMPLE_RATE,
				channelCount: 1,
				channelMask: 0,
				bitDepth,
				frameCount: channel.length,
			},
		);

		await writer.write([channel]);
		await writer.close();

		const layout = crestLayoutOf({
			spreadMs,
			smoothingMs,
			sampleRate: SAMPLE_RATE,
			frameCount: channel.length,
		});
		const meter = new SourceMeter({ stretchFrames: layout.stretchFrames, channelCount: 1, bitDepth });

		meter.push([channel], channel.length);

		const solution = await solveCrest({
			inputPath,
			layout,
			bitDepth,
			channelCount: 1,
			readings: meter.finish(),
		});
		const measured = await applyWalk({
			inputPath,
			sink: { kind: "file", path: outputPath },
			layout,
			bitDepth,
			channelCount: 1,
			walk: solution.walk,
		});

		return {
			layout,
			walk: solution.walk,
			level: solution.level,
			measured,
			written: await readOutput(outputPath),
		};
	};

	it("writes the walk the solve chose and measures what the solve predicted", async () => {
		const channel = peakySource(3000, 19);
		const { layout, walk, level, measured, written } = await solveAndApply(channel, 0.25, 2);
		const expected = renderWalk(channel, layout, walk);
		const accumulator = new TruePeakAccumulator(1);

		accumulator.push([expected], layout.frameCount);

		expect(Array.from(written)).toEqual(Array.from(expected));
		expect(printedDbOf(measured)).toBe(level);
		expect(printedDbOf(accumulator.finalize())).toBe(level);
	});

	it("measures what the solve predicted at the default options", async () => {
		const channel = peakySource(2000, 23);
		const { level, measured } = await solveAndApply(channel, 4, 100);

		expect(printedDbOf(measured)).toBe(level);
	});

	it("writes a full-scale 16-bit source's output as exactly the frames it measured", async () => {
		const quantize16 = quantizerOf("16");
		const channel = peakySource(4000, 29).map((sample, index) =>
			quantize16(index % 2 === 0 ? 0.97 - Math.abs(sample) : -0.97 + Math.abs(sample)),
		);
		const push = vi.spyOn(TruePeakAccumulator.prototype, "push");
		const { measured, written } = await solveAndApply(channel, 4, 100, "16");
		const pushed = push.mock.calls.flatMap(([channels, frameCount]) =>
			Array.from(channels[0]?.subarray(0, frameCount) ?? []),
		);

		push.mockRestore();

		const accumulator = new TruePeakAccumulator(1);

		accumulator.push([written], written.length);

		expect(written.filter((sample) => sample > 0.5).length).toBeGreaterThan(1000);
		expect(Array.from(written)).toEqual(pushed);
		expect(printedDbOf(accumulator.finalize())).toBe(printedDbOf(measured));
	});
});
