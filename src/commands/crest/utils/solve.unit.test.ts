import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { WavWriter } from "../../../wav/WavWriter";
import { dispersionKernelOf } from "./dispersion";
import { crestLayoutOf, stretchFrameCountOf, type CrestLayout } from "./ladder";
import { printedDbOf, quantizerOf } from "./rounding";
import { solveCrest, solveCrestUngated, type CrestSolution } from "./solve";
import { SourceMeter } from "./SourceMeter";
import type { WavBitDepth } from "../../../wav/utils/wavFormat";

interface SolveArguments {
	readonly inputPath: string;
	readonly layout: CrestLayout;
	readonly bitDepth: WavBitDepth;
	readonly channelCount: number;
	readonly readings: Float64Array;
}

const SAMPLE_RATE = 48000;

interface Score {
	readonly level: number;
	readonly identical: number;
}

const quantize = quantizerOf("32f");

const noisy = (frameCount: number, seed: number, amplitude: number): Float64Array => {
	let state = seed >>> 0;
	const channel = new Float64Array(frameCount);

	for (let index = 0; index < frameCount; index++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		channel[index] = Math.fround((state / 0x80000000 - 1) * amplitude);
	}

	return channel;
};

const burst = (channel: Float64Array, position: number, amplitude: number, frequency: number): Float64Array => {
	for (let offset = 0; offset < 6 && position + offset < channel.length; offset++) {
		channel[position + offset] = Math.fround(
			amplitude * Math.exp(-offset / 2) * Math.sin((2 * Math.PI * frequency * offset) / SAMPLE_RATE + 1),
		);
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

const renderWalk = (
	channels: ReadonlyArray<Float64Array>,
	layout: CrestLayout,
	walk: ReadonlyArray<number>,
): Array<Float64Array> =>
	channels.map((channel) => {
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
	});

const scoreWalk = (channels: ReadonlyArray<Float64Array>, layout: CrestLayout, walk: ReadonlyArray<number>): Score => {
	const output = renderWalk(channels, layout, walk);
	const accumulator = new TruePeakAccumulator(channels.length);

	accumulator.push(output, layout.frameCount);

	let identical = 0;

	for (let frame = 0; frame < layout.frameCount; frame++) {
		let isIdentical = true;

		for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
			if ((output[channelIndex]?.[frame] ?? 0) !== quantize(channels[channelIndex]?.[frame] ?? 0)) {
				isIdentical = false;
			}
		}

		if (isIdentical) {
			identical++;
		}
	}

	return { level: printedDbOf(accumulator.finalize()), identical };
};

const everyWalk = (layout: CrestLayout, visit: (walk: ReadonlyArray<number>) => void): void => {
	const walk: Array<number> = new Array<number>(layout.stretchCount + 1).fill(0);
	const extend = (position: number): void => {
		if (position > layout.stretchCount) {
			visit(walk);

			return;
		}

		const first = position === 0 ? 0 : Math.max(0, (walk[position - 1] ?? 0) - 1);
		const last =
			position === 0 ? layout.steps.length - 1 : Math.min(layout.steps.length - 1, (walk[position - 1] ?? 0) + 1);

		for (let stepIndex = first; stepIndex <= last; stepIndex++) {
			walk[position] = stepIndex;
			extend(position + 1);
		}
	};

	extend(0);
};

const bruteForce = (channels: ReadonlyArray<Float64Array>, layout: CrestLayout): Score => {
	let best: Score = { level: Infinity, identical: -1 };

	everyWalk(layout, (walk) => {
		const score = scoreWalk(channels, layout, walk);

		if (score.level < best.level || (score.level === best.level && score.identical > best.identical)) {
			best = score;
		}
	});

	return best;
};

describe("solveCrest", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-crest-solve-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const solveWith = async (
		solver: (args: SolveArguments) => Promise<CrestSolution>,
		channels: ReadonlyArray<Float64Array>,
		spreadMs: number,
		smoothingMs: number,
	): Promise<{ layout: CrestLayout; walk: Array<number>; solution: CrestSolution }> => {
		const path = join(workingDirectory, "source.wav");
		const writer = await WavWriter.create(path, {
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			bitDepth: "32f",
		});

		await writer.write(channels.map((channel) => Float64Array.from(channel)));
		await writer.close();

		const layout = crestLayoutOf({
			spreadMs,
			smoothingMs,
			sampleRate: SAMPLE_RATE,
			frameCount: channels[0]?.length ?? 0,
		});
		const meter = new SourceMeter({
			stretchFrames: layout.stretchFrames,
			channelCount: channels.length,
			bitDepth: "32f",
		});

		meter.push(channels, layout.frameCount);

		const solution = await solver({
			inputPath: path,
			layout,
			bitDepth: "32f",
			channelCount: channels.length,
			readings: meter.finish(),
		});

		return { layout, walk: [...solution.walk], solution };
	};

	const solve = async (
		channels: ReadonlyArray<Float64Array>,
		spreadMs: number,
		smoothingMs: number,
	): Promise<{ layout: CrestLayout; walk: Array<number>; level: number }> => {
		const { layout, walk, solution } = await solveWith(solveCrest, channels, spreadMs, smoothingMs);

		return { layout, walk, level: solution.level };
	};

	const expectGateMatchesChain = async (
		channels: ReadonlyArray<Float64Array>,
		spreadMs: number,
		smoothingMs: number,
	): Promise<{ layout: CrestLayout; solution: CrestSolution }> => {
		const gated = await solveWith(solveCrest, channels, spreadMs, smoothingMs);
		const chained = await solveWith(solveCrestUngated, channels, spreadMs, smoothingMs);

		expect(scoreWalk(channels, gated.layout, gated.walk)).toEqual(scoreWalk(channels, chained.layout, chained.walk));
		expect(gated.solution.level).toBe(chained.solution.level);
		expect(scoreWalk(channels, gated.layout, gated.walk).level).toBe(gated.solution.level);

		return { layout: gated.layout, solution: gated.solution };
	};

	const expectOptimal = async (
		channels: ReadonlyArray<Float64Array>,
		spreadMs: number,
		smoothingMs: number,
	): Promise<{ layout: CrestLayout; walk: Array<number> }> => {
		const { layout, walk, level } = await solve(channels, spreadMs, smoothingMs);
		const scored = scoreWalk(channels, layout, walk);

		expect(scored).toEqual(bruteForce(channels, layout));
		expect(level).toBe(scored.level);

		return { layout, walk };
	};

	it("matches brute force on an isolated peak", async () => {
		await expectOptimal([burst(noisy(60, 9, 0.05), 25, 0.85, 4000)], 0.1, 0.5);
	});

	it("matches brute force on a dense source", async () => {
		await expectOptimal([noisy(48, 31, 0.9)], 0.1, 0.5);
	});

	it("matches brute force on peaks at the first and last frames", async () => {
		await expectOptimal([burst(burst(noisy(48, 41, 0.05), 0, 0.9, 4000), 42, 0.85, 9000)], 0.1, 0.5);
	});

	it("matches brute force in stereo", async () => {
		await expectOptimal(
			[burst(noisy(48, 5, 0.05), 20, 0.85, 4000), burst(noisy(48, 11, 0.05), 30, 0.7, 6000)],
			0.1,
			0.5,
		);
	});

	it("matches brute force when the smoothing floors the stretch at twelve frames", async () => {
		const { layout } = await expectOptimal([burst(noisy(60, 17, 0.05), 25, 0.9, 4000)], 0.1, 0.01);

		expect(layout.stretchFrames).toBe(12);
	});

	it("matches brute force when the last stretch is shorter than a reading", async () => {
		const { layout } = await expectOptimal([burst(noisy(37, 23, 0.05), 20, 0.9, 4000)], 0.1, 0.5);

		expect(layout.stretchFrames).toBe(12);
		expect(stretchFrameCountOf(layout, layout.stretchCount - 1)).toBe(1);

		const wider = await expectOptimal([burst(noisy(41, 27, 0.05), 22, 0.9, 4000)], 0.1, 0.5);

		expect(stretchFrameCountOf(wider.layout, wider.layout.stretchCount - 1)).toBe(5);
	});

	it("leaves a silent source alone", async () => {
		const { layout, walk } = await expectOptimal([new Float64Array(36)], 0.1, 0.5);

		expect(scoreWalk([new Float64Array(36)], layout, walk).identical).toBe(36);
	});

	it("takes a negative step where no positive step reaches as low", async () => {
		const channels = [burst(burst(noisy(60, 39, 0.05), 20, 0.85, 4000), 38, 0.7, 9000)];
		const { layout, walk } = await expectOptimal(channels, 0.1, 0.5);
		let positiveOnly = Infinity;

		expect(walk.some((stepIndex) => stepIndex < layout.zeroStepIndex)).toBe(true);

		everyWalk(layout, (candidate) => {
			if (candidate.every((stepIndex) => stepIndex >= layout.zeroStepIndex)) {
				positiveOnly = Math.min(positiveOnly, scoreWalk(channels, layout, candidate).level);
			}
		});

		expect(scoreWalk(channels, layout, walk).level).toBeLessThan(positiveOnly);
	});

	it("gates an isolated peak to the stretches the ladder reaches", async () => {
		const channels = [burst(noisy(600, 13, 0.02), 300, 0.9, 4000)];
		const { layout, solution } = await expectGateMatchesChain(channels, 0.1, 0.5);

		expect(layout.stretchCount).toBe(50);
		expect(solution.activeStretchCount).toBeLessThan(layout.stretchCount);
		expect(solution.activeStretchCount).toBeGreaterThan(0);
	});

	it("widens the region where the certificate refuses the pinned edges", async () => {
		const channels = [burst(noisy(600, 19, 0.02), 300, 0.9, 4000)];
		const { layout, solution } = await expectGateMatchesChain(channels, 0.1, 0.5);

		expect(solution.widenCount).toBeGreaterThan(0);
		expect(solution.activeStretchCount).toBeLessThan(layout.stretchCount);
	});

	it("gates two peaks a neighbour apart into one region", async () => {
		const channels = [burst(burst(noisy(600, 17, 0.02), 300, 0.9, 4000), 340, 0.88, 1200)];
		const { layout, solution } = await expectGateMatchesChain(channels, 0.1, 0.5);

		expect(solution.activeStretchCount).toBeLessThan(layout.stretchCount);
	});

	it("gates two peaks far enough apart to hold separate regions", async () => {
		const channels = [burst(burst(noisy(900, 19, 0.02), 100, 0.9, 4000), 700, 0.88, 1200)];

		await expectGateMatchesChain(channels, 0.1, 0.5);
	});

	it("gates a peak beside the file's first frame", async () => {
		const channels = [burst(noisy(600, 23, 0.02), 0, 0.9, 4000)];

		await expectGateMatchesChain(channels, 0.1, 0.5);
	});

	it("gates a peak beside the file's last frame", async () => {
		const channels = [burst(noisy(600, 29, 0.02), 594, 0.9, 4000)];

		await expectGateMatchesChain(channels, 0.1, 0.5);
	});

	it("opens the gate over a source that is loud everywhere", async () => {
		const channels = [noisy(600, 31, 0.9)];
		const { layout, solution } = await expectGateMatchesChain(channels, 0.1, 0.5);

		expect(solution.activeStretchCount).toBeGreaterThan(layout.stretchCount - 5);
	});

	it("gates a stereo source", async () => {
		const channels = [burst(noisy(600, 37, 0.02), 300, 0.9, 4000), burst(noisy(600, 41, 0.02), 320, 0.85, 1200)];

		await expectGateMatchesChain(channels, 0.1, 0.5);
	});

	it("gates over the whole ladder the default spread builds", async () => {
		const channels = [burst(noisy(6000, 43, 0.02), 3000, 0.9, 4000)];
		const { layout, solution } = await expectGateMatchesChain(channels, 4, 12);

		expect(layout.steps.length).toBe(23);
		expect(solution.activeStretchCount).toBeLessThan(layout.stretchCount);
	}, 60000);

	it("accepts a stretch the one-step rule lifts on the way to its neighbour", async () => {
		const channels = [burst(burst(noisy(60, 39, 0.05), 20, 0.85, 4000), 38, 0.7, 9000)];
		const { layout, walk } = await expectOptimal(channels, 0.1, 0.5);
		const output = renderWalk(channels, layout, walk);
		const lifted: Array<number> = [];

		for (let stretchIndex = 0; stretchIndex < layout.stretchCount; stretchIndex++) {
			const firstFrame = stretchIndex * layout.stretchFrames;
			let sourcePeak = 0;
			let outputPeak = 0;

			for (let offset = 0; offset < stretchFrameCountOf(layout, stretchIndex); offset++) {
				sourcePeak = Math.max(sourcePeak, Math.abs(channels[0]?.[firstFrame + offset] ?? 0));
				outputPeak = Math.max(outputPeak, Math.abs(output[0]?.[firstFrame + offset] ?? 0));
			}

			if (outputPeak > sourcePeak) {
				lifted.push(stretchIndex);
			}
		}

		expect(lifted.length).toBeGreaterThan(0);

		for (const stretchIndex of lifted) {
			expect(walk[stretchIndex] === layout.zeroStepIndex && walk[stretchIndex + 1] === layout.zeroStepIndex).toBe(
				false,
			);
		}
	});
});
