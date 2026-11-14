import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELAY_FRAMES, FLUSH_FRAMES, TruePeakUpsampler, UPSAMPLE_FACTOR } from "../../../measurement/TruePeakUpsampler";
import { dbToLinear } from "../../../utils/db";
import { Scratch } from "../../../utils/Scratch";
import { createSine } from "../../../utils/testSignals";
import { WavWriter } from "../../../wav/WavWriter";
import { withWavReader } from "../../utils/withWavReader";
import { bodyPeakDbOf, measureSource, type SourceMeasurement } from "./measureSource";

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

	const measureSignal = async (
		channels: ReadonlyArray<Float64Array>,
		limitPercentile = 0.995,
		halfWidth = 0,
	): Promise<SourceMeasurement> => {
		const inputPath = join(workingDirectory, "input.wav");
		const writer = await WavWriter.create(
			{ kind: "file", path: inputPath },
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

		const activeScratch = await Scratch.create();

		scratch = activeScratch;

		return withWavReader(inputPath, async (source) =>
			measureSource({ source, scratch: activeScratch, limitPercentile, halfWidthOf: () => halfWidth }),
		);
	};

	const readAndClose = async (
		measurement: SourceMeasurement,
	): Promise<{ loudness: Float64Array; peak: Float64Array }> => {
		const read = async (file: SourceMeasurement["peakEnvelope"]): Promise<Float64Array> => {
			const values = new Float64Array(file.frameCount);
			let offset = 0;

			for await (const chunk of file.blocks()) {
				values.set(chunk, offset);
				offset += chunk.length;
			}

			return values;
		};
		const loudness = await read(measurement.loudnessEnvelope);
		const peak = await read(measurement.peakEnvelope);

		await measurement.loudnessEnvelope.close();
		await measurement.peakEnvelope.close();

		return { loudness, peak };
	};

	const detectionEnvelopeOf = async (signal: Float64Array): Promise<Float64Array> =>
		(await readAndClose(await measureSignal([signal]))).peak;

	it("reads a steady sine's momentary loudness as its integrated loudness away from the edges", async () => {
		const measurement = await measureSignal(createSine(5 * SAMPLE_RATE, 2, SAMPLE_RATE, 1000, dbToLinear(-12)));
		const { loudness } = await readAndClose(measurement);
		const edge = SAMPLE_RATE / 2;

		for (let frameIndex = edge; frameIndex < loudness.length - edge; frameIndex++) {
			expect(Math.abs((loudness[frameIndex] ?? Number.NaN) - measurement.integratedLufs)).toBeLessThan(0.1);
		}
	});

	it("sets the limit default at the level the loudest 0.5 % of frames reach", async () => {
		const signal = new Float64Array(10 * SAMPLE_RATE).fill(0.1);

		signal.fill(0.5, 5 * SAMPLE_RATE, 5 * SAMPLE_RATE + SAMPLE_RATE / 10);

		const measurement = await measureSignal([signal], 0.995, 480);

		await readAndClose(measurement);

		expect(Math.abs(measurement.limitAutoDb - 20 * Math.log10(0.5))).toBeLessThan(0.05);
	});

	it("reads a steady sine's body peak at its peak level", async () => {
		const measurement = await measureSignal(
			createSine(10 * SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-20)),
			0.995,
			48,
		);

		await readAndClose(measurement);

		expect(Math.abs(bodyPeakDbOf(measurement.detectionHistogram, measurement.pivotAutoDb) + 20)).toBeLessThan(0.5);
	});

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
