import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELAY_FRAMES, FLUSH_FRAMES, TruePeakUpsampler, UPSAMPLE_FACTOR } from "../../../measurement/TruePeakUpsampler";
import { Scratch } from "../../../utils/Scratch";
import { WavWriter } from "../../../wav/WavWriter";
import { withWavReader } from "../../utils/withWavReader";
import { measureSource } from "./measureSource";

const SAMPLE_RATE = 48000;
const SILENCE_FRAMES = 1000;

const upsampledMagnitudes = (signal: Float64Array): Float64Array => {
	const upsampler = new TruePeakUpsampler();
	const output = new Float64Array((signal.length + FLUSH_FRAMES) * UPSAMPLE_FACTOR);

	upsampler.upsample(signal, signal.length, output);
	upsampler.flush(output.subarray(signal.length * UPSAMPLE_FACTOR));

	return output.map(Math.abs);
};

const maxIn = (values: Float64Array, startFrame: number, endFrame: number): number =>
	values
		.subarray((startFrame + DELAY_FRAMES) * UPSAMPLE_FACTOR, (endFrame + DELAY_FRAMES) * UPSAMPLE_FACTOR)
		.reduce((max, value) => Math.max(max, value), 0);

describe("measureSource detection at the file's ends", () => {
	let workingDirectory: string;
	let scratch: Scratch | undefined;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-measure-source-ends-"));
	});

	afterEach(async () => {
		await scratch?.dispose();
		scratch = undefined;
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const detectionEnvelopeOf = async (signal: Float64Array): Promise<Float64Array> => {
		const inputPath = join(workingDirectory, "input.wav");
		const writer = await WavWriter.create(
			{ kind: "file", path: inputPath },
			{ sampleRate: SAMPLE_RATE, channelCount: 1, channelMask: 0, bitDepth: "32f", frameCount: signal.length },
		);

		await writer.write([signal]);
		await writer.close();

		const activeScratch = await Scratch.create();

		scratch = activeScratch;

		const measurement = await withWavReader(inputPath, async (source) =>
			measureSource({ source, scratch: activeScratch, limitPercentile: 0.995, halfWidthOf: () => 0 }),
		);
		const envelope = new Float64Array(measurement.detectionEnvelope.frameCount);
		let offset = 0;

		for await (const chunk of measurement.detectionEnvelope.blocks()) {
			envelope.set(chunk, offset);
			offset += chunk.length;
		}

		await measurement.detectionEnvelope.close();

		return envelope;
	};

	it("credits the ringing past the last frame to the last frame", async () => {
		const ending = [1, -1, 1, -1, 1, -1, 1, -1, -1, 1, 0];
		const signal = new Float64Array(SILENCE_FRAMES + ending.length);

		signal.set(ending, SILENCE_FRAMES);

		const lastFrame = signal.length - 1;
		const magnitudes = upsampledMagnitudes(signal);
		const lastFrameLevel = maxIn(magnitudes, lastFrame, signal.length);
		const pastEndLevel = maxIn(magnitudes, signal.length, signal.length + FLUSH_FRAMES - DELAY_FRAMES);
		const envelope = await detectionEnvelopeOf(signal);

		expect(pastEndLevel).toBeGreaterThan(1.5 * lastFrameLevel);
		expect(envelope).toHaveLength(signal.length);
		expect(Math.abs((envelope[lastFrame] ?? Number.NaN) - 20 * Math.log10(pastEndLevel))).toBeLessThan(1e-9);
	});

	it("credits the ringing before the first frame to the first frame", async () => {
		const opening = [-0.5, -0.5, ...Array.from({ length: 33 }, (_, index) => (index % 2 === 0 ? -1 : 1))];
		const signal = new Float64Array(opening.length + SILENCE_FRAMES);

		signal.set(opening, 0);

		const magnitudes = upsampledMagnitudes(signal);
		const firstFrameLevel = maxIn(magnitudes, 0, 1);
		const preRingLevel = maxIn(magnitudes, -DELAY_FRAMES, 0);
		const envelope = await detectionEnvelopeOf(signal);

		expect(preRingLevel).toBeGreaterThan(1.5 * firstFrameLevel);
		expect(Math.abs((envelope[0] ?? Number.NaN) - 20 * Math.log10(preRingLevel))).toBeLessThan(1e-9);
	});
});
