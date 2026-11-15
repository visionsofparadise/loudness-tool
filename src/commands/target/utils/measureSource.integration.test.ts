import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_OVERSAMPLING,
	OVERSAMPLING_FACTORS,
	DELAY_FRAMES,
	FLUSH_FRAMES,
	TruePeakUpsampler,
	type OversamplingFactor,
} from "../../../measurement/TruePeakUpsampler";
import { dbToLinear } from "../../../utils/db";
import { Scratch } from "../../../utils/Scratch";
import { createNoise, createSine } from "../../../utils/testSignals";
import { writeExtensibleWav } from "../../../utils/testWav";
import { BLOCK_FRAMES } from "../../../wav/WavReader";
import { WavWriter } from "../../../wav/WavWriter";
import { withWavReader } from "../../utils/withWavReader";
import { bodyPeakDbOf, CELL_COUNT, cellOf, measureSource, type SourceMeasurement } from "./measureSource";
import { windowSamplesFromMs } from "./window";

const SAMPLE_RATE = 48000;
const SILENCE_FRAMES = 1000;

const upsampledMagnitudes = (signal: Float64Array, factor: OversamplingFactor): Float64Array => {
	const upsampler = new TruePeakUpsampler(factor);
	const output = new Float64Array((signal.length + FLUSH_FRAMES) * factor);

	upsampler.upsample(signal, signal.length, output);
	upsampler.flush(output.subarray(signal.length * factor));

	return output.map(Math.abs);
};

const maxIn = (values: Float64Array, factor: OversamplingFactor, startFrame: number, endFrame: number): number =>
	values
		.subarray((startFrame + DELAY_FRAMES) * factor, (endFrame + DELAY_FRAMES) * factor)
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
		oversampling: OversamplingFactor = DEFAULT_OVERSAMPLING,
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
			measureSource({ source, scratch: activeScratch, limitPercentile, halfWidthOf: () => halfWidth, oversampling }),
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

	const detectionEnvelopeOf = async (
		signal: Float64Array,
		factor: OversamplingFactor = DEFAULT_OVERSAMPLING,
	): Promise<Float64Array> => (await readAndClose(await measureSignal([signal], 0.995, 0, factor))).peak;

	it("reads a steady sine's momentary loudness as its integrated loudness away from the edges", async () => {
		const measurement = await measureSignal(createSine(5 * SAMPLE_RATE, 2, SAMPLE_RATE, 1000, dbToLinear(-12)));
		const { loudness } = await readAndClose(measurement);
		const edge = SAMPLE_RATE / 2;

		for (let frameIndex = edge; frameIndex < loudness.length - edge; frameIndex++) {
			expect(Math.abs((loudness[frameIndex] ?? Number.NaN) - measurement.integratedLufs)).toBeLessThan(0.1);
		}
	});

	it("reads silence more than 200 ms before an onset as silent and 150 ms before it as louder than -40 LUFS", async () => {
		const signal = new Float64Array(2 * SAMPLE_RATE);
		const [tone = new Float64Array(0)] = createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 1000, dbToLinear(-20));

		signal.set(tone, SAMPLE_RATE);

		const { loudness } = await readAndClose(await measureSignal([signal]));
		const before = (seconds: number): number =>
			loudness[SAMPLE_RATE - Math.round(seconds * SAMPLE_RATE)] ?? Number.NaN;

		expect(before(0.25)).toBe(-200);
		expect(before(0.21)).toBe(-200);
		expect(before(0.15)).toBeGreaterThan(-40);
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

		const bodyPeakDb = await bodyPeakDbOf(
			measurement.loudnessEnvelope,
			measurement.peakEnvelope,
			measurement.pivotAutoDb,
		);

		await readAndClose(measurement);

		expect(Math.abs(bodyPeakDb + 20)).toBeLessThan(0.02);
	});

	it.each(OVERSAMPLING_FACTORS)("credits the ringing past the last frame to the last frame at %ix", async (factor) => {
		const ending = [1, -1, 1, -1, 1, -1, 1, -1, -1, 1, 0];
		const signal = new Float64Array(SILENCE_FRAMES + ending.length);

		signal.set(ending, SILENCE_FRAMES);

		const lastFrame = signal.length - 1;
		const magnitudes = upsampledMagnitudes(signal, factor);
		const lastFrameLevel = maxIn(magnitudes, factor, lastFrame, signal.length);
		const pastEndLevel = maxIn(magnitudes, factor, signal.length, signal.length + FLUSH_FRAMES - DELAY_FRAMES);
		const envelope = await detectionEnvelopeOf(signal, factor);

		expect(pastEndLevel).toBeGreaterThan(1.5 * lastFrameLevel);
		expect(envelope).toHaveLength(signal.length);
		expect(Math.abs((envelope[lastFrame] ?? Number.NaN) - 20 * Math.log10(pastEndLevel))).toBeLessThan(1e-9);
	});

	it.each(OVERSAMPLING_FACTORS)(
		"credits the ringing before the first frame to the first frame at %ix",
		async (factor) => {
			const opening = [-0.5, -0.5, ...Array.from({ length: 33 }, (_, index) => (index % 2 === 0 ? -1 : 1))];
			const signal = new Float64Array(opening.length + SILENCE_FRAMES);

			signal.set(opening, 0);

			const magnitudes = upsampledMagnitudes(signal, factor);
			const firstFrameLevel = maxIn(magnitudes, factor, 0, 1);
			const preRingLevel = maxIn(magnitudes, factor, -DELAY_FRAMES, 0);
			const envelope = await detectionEnvelopeOf(signal, factor);

			expect(preRingLevel).toBeGreaterThan(1.5 * firstFrameLevel);
			expect(Math.abs((envelope[0] ?? Number.NaN) - 20 * Math.log10(preRingLevel))).toBeLessThan(1e-9);
		},
	);
});

describe("measureSource histograms", () => {
	let workingDirectory: string;
	let scratch: Scratch | undefined;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-measure-source-histograms-"));
		scratch = await Scratch.create();
	});

	afterEach(async () => {
		await scratch?.dispose();
		scratch = undefined;
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const measureFile = async (inputPath: string, halfWidth: number): Promise<SourceMeasurement> => {
		const activeScratch = scratch;

		if (activeScratch === undefined) {
			throw new Error("scratch must be created first");
		}

		return withWavReader(inputPath, async (source) =>
			measureSource({
				source,
				scratch: activeScratch,
				limitPercentile: 0.995,
				halfWidthOf: () => halfWidth,
				oversampling: DEFAULT_OVERSAMPLING,
			}),
		);
	};

	const readEnvelopes = async (
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

	it("weights each channel's energy by its stated position", async () => {
		const frameCount = SAMPLE_RATE;
		const [sine = new Float64Array(0)] = createSine(frameCount, 1, SAMPLE_RATE, 997, 0.5);
		const totalEnergyWith = async (signalChannel: number): Promise<number> => {
			const channels = Array.from({ length: 6 }, (_channel, index) =>
				index === signalChannel ? sine : new Float64Array(frameCount),
			);
			const inputPath = join(workingDirectory, `surround-${signalChannel}.wav`);

			await writeExtensibleWav(inputPath, {
				sampleRate: SAMPLE_RATE,
				channelCount: channels.length,
				bitDepth: "32f",
				channelMask: 0x3f,
				channels,
			});

			const measurement = await measureFile(inputPath, windowSamplesFromMs(1, SAMPLE_RATE));

			await readEnvelopes(measurement);

			expect(Array.from(measurement.weights)).toEqual([1, 1, 1, 0, 1.41, 1.41]);

			return measurement.detectionHistogram.energy.reduce((sum, energy) => sum + energy, 0);
		};
		const front = await totalEnergyWith(0);
		const lfe = await totalEnergyWith(3);
		const back = await totalEnergyWith(4);

		expect(front).toBeGreaterThan(0);
		expect(lfe).toBe(0);
		expect(Math.abs(back / (1.41 * front) - 1)).toBeLessThan(1e-9);
	});

	it("pairs each frame's loudness and peak in the histogram across block boundaries", async () => {
		const frameCount = 2 * BLOCK_FRAMES + 8_000;
		const channels = createNoise(frameCount, 2, 7).map((channel) =>
			channel.map((sample, frameIndex) => sample * (0.3 + 0.25 * Math.sin((2 * Math.PI * frameIndex) / 30_001))),
		);
		const [left = new Float64Array(0)] = channels;

		left[100] = 0.95;

		const inputPath = join(workingDirectory, "multi-block.wav");
		const writer = await WavWriter.create(
			{ kind: "file", path: inputPath },
			{ sampleRate: SAMPLE_RATE, channelCount: 2, channelMask: 0, bitDepth: "32f", frameCount },
		);

		await writer.write(channels);
		await writer.close();

		for (const halfWidth of [0, 3, 48]) {
			const measurement = await measureFile(inputPath, halfWidth);
			const { loudness: loudnessDb, peak: peakDb } = await readEnvelopes(measurement);
			const expected = new Float64Array(CELL_COUNT * CELL_COUNT);

			for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
				const cell = cellOf(loudnessDb[frameIndex] ?? 0) * CELL_COUNT + cellOf(peakDb[frameIndex] ?? 0);

				expected[cell] = (expected[cell] ?? 0) + 1;
			}

			expect(loudnessDb).toHaveLength(frameCount);
			expect(peakDb).toHaveLength(frameCount);
			expect(expected.filter((count) => count > 0).length).toBeGreaterThan(20);
			expect(measurement.detectionHistogram.counts).toEqual(expected);
		}
	}, 30_000);
});
