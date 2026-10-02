import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNoise } from "../../../utils/testSignals";
import { WavReader } from "../../../wav/WavReader";
import { WavWriter } from "../../../wav/WavWriter";
import { crestLayoutOf, stretchFrameCountOf, type CrestLayout } from "./ladder";
import {
	allocateChannels,
	forEachStretchChunk,
	measureStretch,
	renderStretch,
	OVERSAMPLE_FACTOR,
	TRUE_PEAK_TAIL_FRAMES,
	type StretchMeasure,
} from "./render";
import { printedDbOf, quantizerOf } from "./rounding";
import { SourceMeter } from "./SourceMeter";
import type { WavBitDepth } from "../../../wav/utils/wavFormat";

const SAMPLE_RATE = 48000;

const windowPositionsOf = (layout: CrestLayout, stretchIndex: number): Array<number> => {
	const firstFrame = stretchIndex * layout.stretchFrames;
	const frameCount = stretchFrameCountOf(layout, stretchIndex);
	const positions: Array<number> = [];

	for (let offset = 0; offset < Math.min(TRUE_PEAK_TAIL_FRAMES, frameCount); offset++) {
		positions.push(firstFrame + offset);
	}

	if (stretchIndex === layout.stretchCount - 1) {
		for (let offset = 0; offset < TRUE_PEAK_TAIL_FRAMES; offset++) {
			positions.push(layout.frameCount + offset);
		}
	}

	return positions;
};

const addContribution = (
	values: Float64Array,
	measure: StretchMeasure,
	firstFrame: number,
	endFrame: number,
	position: number,
	stride: number,
): void => {
	const isInside = position <= endFrame;
	const offset = isInside ? position - firstFrame : position - endFrame - 1;

	if (offset < 0 || offset >= TRUE_PEAK_TAIL_FRAMES) {
		return;
	}

	const table = isInside ? measure.head : measure.carry;

	for (let index = 0; index < stride; index++) {
		values[index] = (values[index] ?? 0) + (table[offset * stride + index] ?? 0);
	}
};

const oracleReadingsOf = async (
	inputPath: string,
	layout: CrestLayout,
	bitDepth: WavBitDepth,
	channelCount: number,
): Promise<Float64Array> => {
	const quantize = quantizerOf(bitDepth);
	const stride = OVERSAMPLE_FACTOR * channelCount;
	const sourceFrames = allocateChannels(channelCount, layout.stretchFrames);
	const scratch = new Float64Array(layout.stretchFrames * OVERSAMPLE_FACTOR);
	const tailScratch = new Float64Array(TRUE_PEAK_TAIL_FRAMES * OVERSAMPLE_FACTOR);
	const values = new Float64Array(stride);
	const readings = new Float64Array(layout.stretchCount);

	const chargeOf = (
		stretchIndex: number,
		positions: ReadonlyArray<number>,
		measure: StretchMeasure,
		previousMeasure: StretchMeasure | undefined,
	): number => {
		const firstFrame = stretchIndex * layout.stretchFrames;
		const endFrame = firstFrame + stretchFrameCountOf(layout, stretchIndex) - 1;
		let peak = measure.peak;

		for (const position of positions) {
			values.fill(0);
			addContribution(values, measure, firstFrame, endFrame, position, stride);

			if (previousMeasure !== undefined) {
				addContribution(
					values,
					previousMeasure,
					firstFrame - layout.stretchFrames,
					firstFrame - 1,
					position,
					stride,
				);
			}

			for (let index = 0; index < stride; index++) {
				const magnitude = Math.abs(values[index] ?? 0);

				if (magnitude > peak) {
					peak = magnitude;
				}
			}
		}

		return peak;
	};

	let previousMeasure: StretchMeasure | undefined;

	await forEachStretchChunk({
		path: inputPath,
		layout,
		ranges: layout.stretchCount === 0 ? [] : [{ firstStretch: 0, lastStretch: layout.stretchCount - 1 }],
		stepIndicesOf: () => [layout.zeroStepIndex],
		handle: (chunk) => {
			for (let offset = 0; offset < chunk.stretchCount; offset++) {
				const stretchIndex = chunk.firstStretch + offset;

				renderStretch({
					chunk,
					layout,
					stretchIndex,
					beginStepIndex: layout.zeroStepIndex,
					endStepIndex: layout.zeroStepIndex,
					quantize,
					output: sourceFrames,
				});

				const measure = measureStretch({
					output: sourceFrames,
					sourceFrames,
					frameCount: stretchFrameCountOf(layout, stretchIndex),
					scratch,
					tailScratch,
				});

				readings[stretchIndex] = printedDbOf(
					chargeOf(stretchIndex, windowPositionsOf(layout, stretchIndex), measure, previousMeasure),
				);
				previousMeasure = measure;
			}
		},
	});

	return readings;
};

const peakySource = (frameCount: number, channelCount: number, seed: number): Array<Float64Array> => {
	const channels = createNoise(frameCount, channelCount, seed).map((channel) =>
		Float64Array.from(channel, (sample) => Math.fround(sample * 0.3)),
	);

	for (let position = 17; position < frameCount; position += 53) {
		for (const channel of channels) {
			channel[position] = Math.fround(position % 2 === 0 ? 0.97 : -0.95);
		}
	}

	return channels;
};

const meterInChunks = async (
	inputPath: string,
	layout: CrestLayout,
	bitDepth: WavBitDepth,
	chunkFrames: number,
): Promise<Float64Array> => {
	const reader = await WavReader.open(inputPath);
	const meter = new SourceMeter({
		stretchFrames: layout.stretchFrames,
		channelCount: reader.format.channelCount,
		bitDepth,
	});

	try {
		for await (const block of reader.blocks()) {
			const frameCount = block.channels[0]?.length ?? 0;

			for (let offset = 0; offset < frameCount; offset += chunkFrames) {
				const take = Math.min(chunkFrames, frameCount - offset);

				meter.push(
					block.channels.map((channel) => channel.slice(offset, offset + take)),
					take,
				);
			}
		}
	} finally {
		await reader.close();
	}

	return meter.finish();
};

describe("SourceMeter", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-crest-meter-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const expectMatchesOracle = async (args: {
		frameCount: number;
		channelCount: number;
		bitDepth: "16" | "32f";
		spreadMs: number;
		smoothingMs: number;
		chunkFrames?: ReadonlyArray<number>;
	}): Promise<CrestLayout> => {
		const inputPath = join(workingDirectory, "source.wav");
		const writer = await WavWriter.create(inputPath, {
			sampleRate: SAMPLE_RATE,
			channelCount: args.channelCount,
			bitDepth: args.bitDepth,
		});

		await writer.write(peakySource(args.frameCount, args.channelCount, args.frameCount + 7));
		await writer.close();

		const layout = crestLayoutOf({
			spreadMs: args.spreadMs,
			smoothingMs: args.smoothingMs,
			sampleRate: SAMPLE_RATE,
			frameCount: args.frameCount,
		});
		const expected = await oracleReadingsOf(inputPath, layout, args.bitDepth, args.channelCount);

		expect(expected.length).toBe(layout.stretchCount);

		for (const chunkFrames of args.chunkFrames ?? [1, 13, 65536]) {
			expect(await meterInChunks(inputPath, layout, args.bitDepth, chunkFrames)).toEqual(expected);
		}

		return layout;
	};

	it("matches the whole-file meter when the source is a multiple of the stretch", async () => {
		const layout = await expectMatchesOracle({
			frameCount: 120,
			channelCount: 1,
			bitDepth: "32f",
			spreadMs: 0.1,
			smoothingMs: 0.5,
		});

		expect(layout.stretchFrames).toBe(12);
		expect(layout.frameCount % layout.stretchFrames).toBe(0);
	});

	it("matches the whole-file meter one frame past a multiple of the stretch", async () => {
		const layout = await expectMatchesOracle({
			frameCount: 121,
			channelCount: 1,
			bitDepth: "32f",
			spreadMs: 0.1,
			smoothingMs: 0.5,
		});

		expect(stretchFrameCountOf(layout, layout.stretchCount - 1)).toBe(1);
	});

	it("matches the whole-file meter at the default stretch one frame past a multiple", async () => {
		const layout = await expectMatchesOracle({
			frameCount: 436 * 3 + 1,
			channelCount: 1,
			bitDepth: "32f",
			spreadMs: 4,
			smoothingMs: 100,
		});

		expect(layout.stretchFrames).toBe(436);
	});

	it("matches the whole-file meter when the final stretch is under eleven frames", async () => {
		const layout = await expectMatchesOracle({
			frameCount: 65,
			channelCount: 1,
			bitDepth: "32f",
			spreadMs: 0.1,
			smoothingMs: 0.5,
		});

		expect(stretchFrameCountOf(layout, layout.stretchCount - 1)).toBe(5);
	});

	it("matches the whole-file meter on a source under eleven frames", async () => {
		const layout = await expectMatchesOracle({
			frameCount: 7,
			channelCount: 1,
			bitDepth: "32f",
			spreadMs: 0.1,
			smoothingMs: 0.5,
		});

		expect(layout.stretchCount).toBe(1);
	});

	it("matches the whole-file meter across the reader's and the oracle's block boundaries", async () => {
		const layout = await expectMatchesOracle({
			frameCount: 70000,
			channelCount: 1,
			bitDepth: "32f",
			spreadMs: 0.1,
			smoothingMs: 0.5,
			chunkFrames: [13, 65536],
		});

		expect(layout.frameCount).toBeGreaterThan(65536);
	});

	it("returns no readings for a source with no frames", async () => {
		const layout = await expectMatchesOracle({
			frameCount: 0,
			channelCount: 1,
			bitDepth: "32f",
			spreadMs: 0.1,
			smoothingMs: 0.5,
		});

		expect(layout.stretchCount).toBe(0);
	});

	it("matches the whole-file meter in stereo", async () => {
		await expectMatchesOracle({ frameCount: 157, channelCount: 2, bitDepth: "32f", spreadMs: 0.1, smoothingMs: 0.5 });
	});

	it("matches the whole-file meter on a 16-bit source", async () => {
		await expectMatchesOracle({ frameCount: 157, channelCount: 2, bitDepth: "16", spreadMs: 0.1, smoothingMs: 0.5 });
	});
});
