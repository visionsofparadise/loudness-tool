import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTestWav } from "../../../utils/testCli";
import { createNoise } from "../../../utils/testSignals";
import { PAIR_COUNT, type WindowedSolve } from "./blend";
import { crestLayoutOf, type CrestLayout } from "./layout";
import { chunkStretchesOf, forEachStretchChunk, OVERSAMPLE_FACTOR } from "./render";
import { solveStage } from "./solveStage";
import { oracleOf, stretchPeaksOf, upsampledOf } from "./testBlendOracle";

const SAMPLE_RATE = 48000;
const FRAME_COUNT = 50000;
const BURST_FRAMES = 6;

interface Burst {
	readonly frame: number;
	readonly amplitude: number;
	readonly channel?: number;
}

const layoutOf = (frameCount: number): CrestLayout =>
	crestLayoutOf({ spreadMs: 0.05, steps: 1, smoothingMs: 10, sampleRate: SAMPLE_RATE, frameCount });

const layout = layoutOf(FRAME_COUNT);
const chunkStretches = chunkStretchesOf(layout);
const stretchFrames = layout.stretchFrames;

const withBursts = (channels: Array<Float64Array>, bursts: ReadonlyArray<Burst>): Array<Float64Array> => {
	for (const [channelIndex, channel] of channels.entries()) {
		for (const burst of bursts.filter((candidate) => (candidate.channel ?? channelIndex) === channelIndex)) {
			for (let offset = 0; offset < BURST_FRAMES && burst.frame + offset < channel.length; offset++) {
				const sign = (offset + channelIndex) % 2 === 0 ? 1 : -1;

				channel[burst.frame + offset] =
					(channel[burst.frame + offset] ?? 0) + sign * burst.amplitude * (1 - offset / BURST_FRAMES);
			}
		}
	}

	return channels;
};

const quietNoise = (channelCount: number, seed: number): Array<Float64Array> =>
	createNoise(FRAME_COUNT, channelCount, seed).map((channel) => channel.map((sample) => 0.05 * sample));

const burstAt = (stretchIndex: number, offset: number, amplitude: number): Burst => ({
	frame: stretchIndex * stretchFrames + offset,
	amplitude,
});

const dispersedOf = async (
	path: string,
	crestLayout: CrestLayout,
	channelCount: number,
	stepIndex: number,
): Promise<Array<Float64Array>> => {
	const dispersed = Array.from({ length: channelCount }, () => new Float64Array(crestLayout.frameCount));

	await forEachStretchChunk({
		path,
		layout: crestLayout,
		ranges: [{ firstStretch: 0, lastStretch: crestLayout.stretchCount - 1 }],
		stepIndicesOf: () => [stepIndex],
		handle: (chunk) => {
			const frameCount = Math.min(
				crestLayout.frameCount - chunk.firstFrame,
				chunk.stretchCount * crestLayout.stretchFrames,
			);

			for (const [channelIndex, channel] of dispersed.entries()) {
				channel.set(chunk.dispersed[stepIndex]?.[channelIndex]?.subarray(0, frameCount) ?? [], chunk.firstFrame);
			}
		},
	});

	return dispersed;
};

describe("solveStage", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-crest-solve-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const expectOracle = async (
		source: Array<Float64Array>,
		current: Array<Float64Array> = source,
		stepIndex = 0,
	): Promise<WindowedSolve> => {
		const frameCount = source[0]?.length ?? 0;
		const stageLayout = layoutOf(frameCount);
		const sourcePath = join(workingDirectory, "source.wav");
		const currentPath = join(workingDirectory, "current.wav");

		await writeTestWav(sourcePath, source, { bitDepth: "64f" });
		await writeTestWav(currentPath, current, { bitDepth: "64f" });

		const currentUpsampled = current.map(upsampledOf);
		const dispersedUpsampled = (await dispersedOf(sourcePath, stageLayout, source.length, stepIndex)).map(
			upsampledOf,
		);
		const peaks = stretchPeaksOf(currentUpsampled, frameCount, stretchFrames);

		const solve = await solveStage({
			sourcePath,
			currentPath,
			layout: stageLayout,
			stepIndex,
			peaks,
		});
		const oracle = oracleOf({
			current: currentUpsampled,
			dispersed: dispersedUpsampled,
			frameCount,
			stretchFrames,
		});
		const level = solve.level();

		expect(level).toBe(oracle.level);
		expect(Array.from(solve.path())).toEqual(Array.from(oracle.path));

		for (let stretchIndex = 0; stretchIndex < stageLayout.stretchCount; stretchIndex++) {
			const costs = solve.costsOf(stretchIndex);

			if (costs === undefined) {
				continue;
			}

			for (let pairIndex = 0; pairIndex < PAIR_COUNT; pairIndex++) {
				expect(Math.max(costs[pairIndex] ?? 0, level)).toBe(
					Math.max(oracle.costs[stretchIndex]?.[pairIndex] ?? 0, level),
				);
			}
		}

		return solve;
	};

	it("scores a burst at the start of a chunk with the chunk before's dispersion as its lead-in", async () => {
		const solve = await expectOracle(withBursts(quietNoise(1, 61), [burstAt(chunkStretches, 2, 0.9)]));

		expect(solve.seedStretch).toBe(chunkStretches);
		expect(solve.costsOf(chunkStretches - 1)).toBeDefined();
		expect(solve.costsOf(chunkStretches)).toBeDefined();
	});

	it("disperses the chunk before a near region that starts on a chunk's first stretch for its lead-in only", async () => {
		const solve = await expectOracle(withBursts(quietNoise(1, 67), [burstAt(chunkStretches + 10, 20, 0.9)]));

		expect(solve.costsOf(chunkStretches - 1)).toBeUndefined();
		expect(solve.costsOf(chunkStretches)).toBeDefined();
	});

	it("seeds at a loudest burst near the end, after the forward pass's first scored stretch", async () => {
		const solve = await expectOracle(
			withBursts(quietNoise(1, 71), [burstAt(40, 7, 0.98), burstAt(420, 30, 0.97), burstAt(1000, 11, 1)]),
		);

		expect(solve.seedStretch).toBe(1000);
		expect(solve.costsOf(30)).toBeDefined();
	});

	it("scores a near region spanning two chunk boundaries", async () => {
		const bursts = Array.from({ length: 26 }, (_burst, index) => burstAt(320 + 15 * index, 20, 0.9));
		const solve = await expectOracle(withBursts(quietNoise(1, 73), bursts));

		for (const stretchIndex of [chunkStretches - 1, chunkStretches, 2 * chunkStretches - 1, 2 * chunkStretches]) {
			expect(solve.costsOf(stretchIndex)).toBeDefined();
		}
	});

	it("disperses the source and scores the current input on stereo", async () => {
		const bursts = [burstAt(200, 5, 0.8), { ...burstAt(700, 40, 0.95), channel: 1 }];
		const source = withBursts(quietNoise(2, 79), bursts);
		const current = withBursts(
			source.map((channel) => Float64Array.from(channel)),
			[{ ...burstAt(900, 9, 1.1), channel: 1 }],
		);
		const solve = await expectOracle(source, current);

		expect(solve.seedStretch).toBe(900);
	});

	it("reads 12 frames of lead-in before a seed on a chunk's first stretch", async () => {
		const channel = new Float64Array(FRAME_COUNT);
		const chunkFirstFrame = chunkStretches * stretchFrames;

		for (let offset = 0; offset < 7; offset++) {
			channel[chunkFirstFrame - 11 + offset] = 0.4 + 0.1 * offset;
		}

		const solve = await expectOracle([channel]);

		expect(solve.seedStretch).toBe(chunkStretches);
		expect(solve.level()).toBeGreaterThan(solve.seedThreshold);
	});

	it("scores a burst in the file's last, partial stretch", async () => {
		const solve = await expectOracle(withBursts(quietNoise(1, 83), [{ frame: FRAME_COUNT - 4, amplitude: 1 }]));

		expect(FRAME_COUNT % stretchFrames).toBeGreaterThan(0);
		expect(solve.seedStretch).toBe(layout.stretchCount - 1);
	});

	it("scores the second channel's flush tail when a click on its last frame binds", async () => {
		const channels = quietNoise(2, 97);
		const ringing = channels[1];

		if (ringing !== undefined) {
			ringing[FRAME_COUNT - 1] = 1;
		}

		const solve = await expectOracle(channels);

		expect(solve.seedStretch).toBe(layout.stretchCount - 1);
		expect(solve.level()).toBeGreaterThan(solve.seedThreshold);
	});

	it("seeds at a burst in the first stretch", async () => {
		const solve = await expectOracle(withBursts(quietNoise(1, 89), [{ frame: 2, amplitude: 1 }]));

		expect(solve.seedStretch).toBe(0);
	});

	it("solves a file shorter than one stretch", async () => {
		const solve = await expectOracle([Float64Array.of(0, 0.9, -0.7, 0.3, 0)]);

		expect(solve.costsOf(0)).toBeDefined();
	});

	it.each([
		{ stepIndex: 0, spikeOffset: 24, spike: 3.5 },
		{ stepIndex: 1, spikeOffset: 24, spike: 6 },
	])(
		"seeds on a chunk's first stretch from 12 frames of the current input and the chunk before's dispersion at step $stepIndex",
		async ({ stepIndex, spikeOffset, spike }) => {
			const current = new Float64Array(FRAME_COUNT);
			const chunkFirstFrame = chunkStretches * stretchFrames;
			const quietStretch = 100;

			for (let offset = 0; offset < 7; offset++) {
				current[chunkFirstFrame - 11 + offset] = 0.4 + 0.1 * offset;
			}

			const source = current.map((sample) => -sample);

			source[chunkFirstFrame + spikeOffset] = spike;
			current[quietStretch * stretchFrames + 20] = 0.7;

			const solve = await expectOracle([source], [current], stepIndex);
			const quietPeak = Math.max(
				...upsampledOf(current)
					.subarray(
						quietStretch * stretchFrames * OVERSAMPLE_FACTOR,
						(quietStretch + 1) * stretchFrames * OVERSAMPLE_FACTOR,
					)
					.map(Math.abs),
			);

			expect(solve.seedStretch).toBe(chunkStretches);
			expect(quietPeak).toBeGreaterThan(solve.seedThreshold);
			expect(quietPeak).toBeLessThan(solve.level());
			expect(solve.costsOf(quietStretch)).toBeUndefined();
		},
	);
});
