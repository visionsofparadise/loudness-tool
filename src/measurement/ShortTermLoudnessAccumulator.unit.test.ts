import { describe, expect, it } from "vitest";
import { createLevelSegments, createSine } from "../utils/testSignals";
import { computeLoudnessRange } from "./loudnessRange";
import { ShortTermLoudnessAccumulator } from "./ShortTermLoudnessAccumulator";

const SAMPLE_RATE = 48000;
const LUFS_OFFSET = -0.691;
const POWER_FLOOR_LUFS = LUFS_OFFSET + 10 * Math.log10(1e-10);

const measure = (channels: ReadonlyArray<Float64Array>, sampleRate: number): Float64Array => {
	const accumulator = new ShortTermLoudnessAccumulator(sampleRate, channels.length);

	accumulator.push(channels, channels[0]?.length ?? 0);

	return accumulator.finalize();
};

const measureChunked = (
	channels: ReadonlyArray<Float64Array>,
	sampleRate: number,
	chunkFrames: number,
): Float64Array => {
	const frameCount = channels[0]?.length ?? 0;
	const accumulator = new ShortTermLoudnessAccumulator(sampleRate, channels.length);

	for (let offset = 0; offset < frameCount; offset += chunkFrames) {
		const frames = Math.min(chunkFrames, frameCount - offset);
		const slices = channels.map((channel) => channel.subarray(offset, offset + frames));

		accumulator.push(slices, frames);
	}

	return accumulator.finalize();
};

describe("ShortTermLoudnessAccumulator", () => {
	it.each([
		{ levels: [-20, -30], expected: 10 },
		{ levels: [-20, -15], expected: 5 },
		{ levels: [-40, -20], expected: 20 },
		{ levels: [-50, -35, -20, -35, -50], expected: 15 },
	])("Tech 3342 minimum-requirements levels $levels yield $expected LU LRA", ({ levels, expected }) => {
		const channels = createLevelSegments(
			levels.map((db) => ({ seconds: 20, frequency: 1000, db })),
			SAMPLE_RATE,
			2,
		);
		const shortTerm = measure(channels, SAMPLE_RATE);

		expect(Math.abs(computeLoudnessRange(shortTerm) - expected)).toBeLessThanOrEqual(1);
	});

	it("returns an empty series when source plus 1.5 s tail is shorter than one 3 s window", () => {
		const shortOfAWindow = Math.round(1.5 * SAMPLE_RATE) - 1;
		const channels = createSine(shortOfAWindow, 1, SAMPLE_RATE, 1000, 0.1);

		expect(measure(channels, SAMPLE_RATE)).toEqual(new Float64Array(0));
	});

	it("closes windows from the 1.5 s zero-feed tail", () => {
		const tailClosesAWindow = Math.round(1.5 * SAMPLE_RATE);
		const channels = createSine(tailClosesAWindow, 1, SAMPLE_RATE, 1000, 0.1);
		const shortTerm = measure(channels, SAMPLE_RATE);

		expect(shortTerm.length).toBeGreaterThan(0);
	});

	it("decays a loud ending into the series through the zero-feed tail", () => {
		const channels = createSine(SAMPLE_RATE * 3, 1, SAMPLE_RATE, 1000, 1);
		const shortTerm = measure(channels, SAMPLE_RATE);

		expect(shortTerm.length).toBeGreaterThan(1);
		expect(shortTerm[0] ?? 0).toBeGreaterThan(shortTerm[shortTerm.length - 1] ?? 0);
	});

	it("silence of 4 s yields the power-floor LUFS and LRA 0", () => {
		const silence = [new Float64Array(SAMPLE_RATE * 4)];
		const shortTerm = measure(silence, SAMPLE_RATE);

		expect(shortTerm.length).toBeGreaterThan(1);

		for (const value of shortTerm) {
			expect(value).toBeCloseTo(POWER_FLOOR_LUFS, 3);
		}

		expect(computeLoudnessRange(shortTerm)).toBe(0);
	});

	it("many small pushes are bit-equal to one whole push", () => {
		const channels = createSine(SAMPLE_RATE * 5, 1, SAMPLE_RATE, 1000, 0.1);
		const oneShot = measure(channels, SAMPLE_RATE);

		expect(Array.from(measureChunked(channels, SAMPLE_RATE, 64))).toEqual(Array.from(oneShot));
		expect(Array.from(measureChunked(channels, SAMPLE_RATE, 4096))).toEqual(Array.from(oneShot));
		expect(Array.from(measureChunked(channels, SAMPLE_RATE, 7777))).toEqual(Array.from(oneShot));
	});

	it("finalize is idempotent and rejects every later push", () => {
		const accumulator = new ShortTermLoudnessAccumulator(SAMPLE_RATE, 1);

		accumulator.push([new Float64Array(SAMPLE_RATE).fill(0.1)], SAMPLE_RATE);

		const first = accumulator.finalize();

		expect(accumulator.finalize()).toBe(first);
		expect(() => accumulator.push([new Float64Array([0.25])], 1)).toThrow("push after finalize");
		expect(() => accumulator.push([new Float64Array(0)], 0)).toThrow("push after finalize");
	});

	it("throws with its own prefix when channelCount is not positive", () => {
		expect(() => new ShortTermLoudnessAccumulator(SAMPLE_RATE, 0)).toThrow(
			"ShortTermLoudnessAccumulator: channelCount must be positive, got 0",
		);
	});

	it("sourceWindowCount follows source length at window boundaries", () => {
		const blockSize = Math.round(3 * SAMPLE_RATE);
		const blockStep = Math.round(0.1 * SAMPLE_RATE);
		const windowsOf = (sourceFrames: number): { sourceWindowCount: number; seriesLength: number } => {
			const channels = createSine(sourceFrames, 1, SAMPLE_RATE, 1000, 0.1);
			const accumulator = new ShortTermLoudnessAccumulator(SAMPLE_RATE, 1);

			accumulator.push(channels, sourceFrames);

			const series = accumulator.finalize();

			return { sourceWindowCount: accumulator.sourceWindowCount, seriesLength: series.length };
		};
		const justShort = windowsOf(blockSize - 1);
		const oneWindow = windowsOf(blockSize);
		const partWayToTwo = windowsOf(blockSize + blockStep - 1);
		const twoWindows = windowsOf(blockSize + blockStep);
		const justShortTail = justShort.seriesLength - justShort.sourceWindowCount;

		expect(justShort.sourceWindowCount).toBe(0);
		expect(oneWindow.sourceWindowCount).toBe(1);
		expect(partWayToTwo.sourceWindowCount).toBe(1);
		expect(twoWindows.sourceWindowCount).toBe(2);
		expect(justShortTail).toBeGreaterThan(0);
		expect(oneWindow.seriesLength - oneWindow.sourceWindowCount).toBe(justShortTail);
		expect(partWayToTwo.seriesLength - partWayToTwo.sourceWindowCount).toBe(justShortTail);
		expect(twoWindows.seriesLength - twoWindows.sourceWindowCount).toBe(justShortTail);
	});
});
