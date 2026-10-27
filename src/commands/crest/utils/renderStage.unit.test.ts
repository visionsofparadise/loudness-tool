import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { decodedSamplesOf, writeTestWav } from "../../../utils/testCli";
import { createNoise } from "../../../utils/testSignals";
import { weightOf } from "./blend";
import { crestLayoutOf } from "./layout";
import { chunkStretchesOf, forEachStretchChunk } from "./render";
import { renderStage } from "./renderStage";
import { quantizerOf } from "./rounding";
import { stretchPeaksOf, upsampledOf } from "./testBlendOracle";
import type { AudioOutput } from "../../utils/sinks";

const SAMPLE_RATE = 48000;
const FRAME_COUNT = 80000;
const STEP_INDEX = 1;

const layout = crestLayoutOf({
	spreadMs: 0.1,
	steps: 1,
	smoothingMs: 0.5,
	sampleRate: SAMPLE_RATE,
	frameCount: FRAME_COUNT,
});

const sixteenBitOutputOf = (path: string): AudioOutput => ({
	sink: { kind: "file", path },
	container: "wav",
	bitDepth: "16",
	channelMask: 0,
});

const highCodes = (channelCount: number, seed: number): Array<Float64Array> =>
	createNoise(FRAME_COUNT, channelCount, seed).map((channel) =>
		channel.map((sample) => (Math.round(0x4000 + Math.abs(sample) * 0x3fff) * Math.sign(sample || 1)) / 0x8000),
	);

const rampOf = (path: Int32Array, firstBoundary: number, states: ReadonlyArray<number>): void => {
	for (const [offset, state] of states.entries()) {
		path[firstBoundary + offset] = state;
	}
};

const chunkStretches = chunkStretchesOf(layout);

const pathWithGaps = (): Int32Array => {
	const path = new Int32Array(layout.stretchCount + 1);

	rampOf(path, 2 * chunkStretches, [1, 2, 3, 2, 1]);
	rampOf(
		path,
		4 * chunkStretches + 500,
		Array.from({ length: 19 }, (_state, offset) => 10 - Math.abs(offset - 9)),
	);

	return path;
};

const peaksOf = (channels: ReadonlyArray<Float64Array>): Array<number> =>
	Array.from(stretchPeaksOf(channels.map(upsampledOf), FRAME_COUNT, layout.stretchFrames));

const dispersedOf = async (path: string, channelCount: number): Promise<Array<Float64Array>> => {
	const dispersed = Array.from({ length: channelCount }, () => new Float64Array(FRAME_COUNT));

	await forEachStretchChunk({
		path,
		layout,
		ranges: [{ firstStretch: 0, lastStretch: layout.stretchCount - 1 }],
		stepIndicesOf: () => [STEP_INDEX],
		handle: (chunk) => {
			const frameCount = Math.min(FRAME_COUNT - chunk.firstFrame, chunk.stretchCount * layout.stretchFrames);

			for (const [channelIndex, channel] of dispersed.entries()) {
				channel.set(chunk.dispersed[STEP_INDEX]?.[channelIndex]?.subarray(0, frameCount) ?? [], chunk.firstFrame);
			}
		},
	});

	return dispersed;
};

describe("renderStage", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-crest-render-stage-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("writes a 16-bit source back byte-identical on an all-zero path", async () => {
		const sourcePath = join(workingDirectory, "source.wav");
		const outputPath = join(workingDirectory, "out.wav");

		await writeTestWav(sourcePath, highCodes(2, 83), { bitDepth: "16" });

		const result = await renderStage({
			sourcePath,
			currentPath: sourcePath,
			layout,
			stepIndex: STEP_INDEX,
			path: new Int32Array(layout.stretchCount + 1),
			output: sixteenBitOutputOf(outputPath),
			isLast: true,
		});

		expect((await readFile(outputPath)).equals(await readFile(sourcePath))).toBe(true);
		expect(Array.from(result.peaks)).toEqual(peaksOf(await decodedSamplesOf(sourcePath)));
	});

	it("writes the quantized blend where the weight is above zero and the quantized current input around and between it", async () => {
		const sourcePath = join(workingDirectory, "source.wav");
		const currentPath = join(workingDirectory, "current.wav");
		const outputPath = join(workingDirectory, "out.wav");
		const current = createNoise(FRAME_COUNT, 2, 89).map((channel) => channel.map((sample) => 0.5 * sample));
		const path = pathWithGaps();
		const loud = current[1];

		if (loud !== undefined) {
			loud[100] = 0.95 + 1e-7;
		}

		await writeTestWav(sourcePath, highCodes(2, 97), { bitDepth: "16" });
		await writeTestWav(currentPath, current, { bitDepth: "64f" });

		const result = await renderStage({
			sourcePath,
			currentPath,
			layout,
			stepIndex: STEP_INDEX,
			path,
			output: sixteenBitOutputOf(outputPath),
			isLast: true,
		});
		const dispersed = await dispersedOf(sourcePath, 2);
		const decoded = await decodedSamplesOf(outputPath);
		const quantize = quantizerOf("16");
		let blendedFrames = 0;

		for (const [channelIndex, channel] of decoded.entries()) {
			const currentChannel = current[channelIndex] ?? new Float64Array(0);
			const dispersedChannel = dispersed[channelIndex] ?? new Float64Array(0);

			for (let frame = 0; frame < FRAME_COUNT; frame++) {
				const sample = currentChannel[frame] ?? 0;
				const weight = weightOf(path, frame, layout.stretchFrames);

				blendedFrames += channelIndex === 0 && weight > 0 ? 1 : 0;

				expect((channel[frame] ?? 0) + 0).toBe(
					quantize(weight > 0 ? sample + weight * ((dispersedChannel[frame] ?? 0) - sample) : sample) + 0,
				);
			}
		}

		const accumulator = new TruePeakAccumulator(2);

		accumulator.push(decoded, FRAME_COUNT);

		expect(path[2 * chunkStretches - 1]).toBe(0);
		expect(blendedFrames).toBeGreaterThan(layout.stretchFrames * 20);
		expect(result.truePeak).toBe(accumulator.finalize());
		expect(Array.from(result.peaks)).toEqual(peaksOf(decoded));
	});
});
