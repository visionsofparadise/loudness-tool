import { describe, expect, it } from "vitest";
import { FLUSH_FRAMES } from "../../../measurement/TruePeakUpsampler";
import { createNoise } from "../../../utils/testSignals";
import { candidatesOf, costTableOf, pairIndexOf, PAIR_COUNT, weightBetween, weightOf, WindowedSolve } from "./blend";
import { WEIGHT_LEVELS } from "./layout";
import { OVERSAMPLE_FACTOR } from "./render";
import { oracleOf, upsampledOf } from "./testBlendOracle";

const STRETCH_FRAMES = 4;
const STRETCH_COUNT = 61;
const HOT_STRETCH = 30;

const lastFrameCandidates = (
	pairs: ReadonlyArray<{ current: number; dispersed: number }>,
	threshold: number,
): Float64Array => {
	const current = new Float64Array(STRETCH_FRAMES * 4);
	const dispersed = new Float64Array(STRETCH_FRAMES * 4);

	pairs.forEach((pair, index) => {
		current[(STRETCH_FRAMES - 1) * 4 + index] = pair.current;
		dispersed[(STRETCH_FRAMES - 1) * 4 + index] = pair.dispersed;
	});

	return candidatesOf({
		current: [current],
		dispersed: [dispersed],
		frameCount: STRETCH_FRAMES,
		stretchFrames: STRETCH_FRAMES,
		threshold,
	});
};

const hotPeaks = (): Float64Array => {
	const peaks = new Float64Array(STRETCH_COUNT);

	peaks[HOT_STRETCH] = 1;

	return peaks;
};

const solveAroundHotStretch = (solve: WindowedSolve, scoreHot: (threshold: number) => Float64Array): void => {
	for (let stretchIndex = 0; stretchIndex < STRETCH_COUNT; stretchIndex++) {
		if (stretchIndex === HOT_STRETCH) {
			solve.advance(stretchIndex, scoreHot(solve.threshold()));
		} else if (Math.abs(stretchIndex - HOT_STRETCH) <= WEIGHT_LEVELS) {
			solve.advance(stretchIndex, costTableOf(new Float64Array(0)));
		} else {
			solve.advance(stretchIndex, undefined);
		}
	}
};

describe("weightBetween", () => {
	it("moves from the stretch's first state toward its last", () => {
		expect(weightBetween(2, 3, 0.25)).toBeCloseTo(0.225, 15);
	});
});

describe("weightOf", () => {
	it("weighs a frame at its offset plus one over the stretch", () => {
		const path = Int32Array.of(2, 3, 1);

		expect(weightOf(path, 0, 4)).toBeCloseTo(0.225, 15);
		expect(weightOf(path, 3, 4)).toBeCloseTo(0.3, 15);
		expect(weightOf(path, 5, 4)).toBeCloseTo(0.2, 15);
	});
});

describe("costTableOf", () => {
	it("cancels a candidate whose dispersion is its negation at half weight", () => {
		const costs = costTableOf(
			candidatesOf({
				current: [Float64Array.of(0.8, 0, 0, 0)],
				dispersed: [Float64Array.of(-0.8, 0, 0, 0)],
				frameCount: 1,
				stretchFrames: 1,
				threshold: 0,
			}),
		);

		expect(costs[pairIndexOf(0, 0)]).toBe(0.8);
		expect(costs[pairIndexOf(5, 5)]).toBe(0);
	});
});

describe("candidatesOf", () => {
	it("drops samples at or below the threshold", () => {
		const candidates = candidatesOf({
			current: [Float64Array.of(0.5, 0.2, 0.6, 0)],
			dispersed: [Float64Array.of(0.1, 0.5, 0, 0.7)],
			frameCount: 1,
			stretchFrames: 1,
			threshold: 0.5,
		});

		expect(Array.from(candidates)).toEqual([0.6, -0.6, 1, 0, 0.7, 1]);
	});

	it("scores a candidate at its frame's place in the stretch between two states", () => {
		const current = new Float64Array(STRETCH_FRAMES * OVERSAMPLE_FACTOR);

		current[1] = 1;

		const costs = costTableOf(
			candidatesOf({
				current: [current],
				dispersed: [new Float64Array(STRETCH_FRAMES * OVERSAMPLE_FACTOR)],
				frameCount: STRETCH_FRAMES,
				stretchFrames: STRETCH_FRAMES,
				threshold: 0,
			}),
		);

		expect(costs[pairIndexOf(2, 3)]).toBeCloseTo(0.775, 15);
		expect(costs[pairIndexOf(3, 2)]).toBeCloseTo(0.725, 15);
	});
});

describe("WindowedSolve", () => {
	it("seeds at the first of the loudest stretches", () => {
		expect(new WindowedSolve({ peaks: Float64Array.of(0.2, 0.5, 0.3, 0.5) }).seedStretch).toBe(1);
		expect(new WindowedSolve({ peaks: new Float64Array(0) }).seedStretch).toBe(-1);
	});

	it("lists as near exactly the stretches isNear accepts", () => {
		const peaks = new Float64Array(80);

		peaks[0] = 0.9;
		peaks[30] = 0.75;
		peaks[45] = 0.7;
		peaks[60] = 1;
		peaks[79] = 0.71;

		const solve = new WindowedSolve({ peaks });

		solve.seed(Float64Array.of(0.7));

		const near = solve.nearStretches();
		const expected = [
			...Array.from({ length: 11 }, (_near, index) => index),
			...Array.from({ length: 21 }, (_near, index) => 20 + index),
			...Array.from({ length: 30 }, (_near, index) => 50 + index),
		];

		for (let stretchIndex = 0; stretchIndex < peaks.length; stretchIndex++) {
			expect(near[stretchIndex] === 1).toBe(solve.isNear(stretchIndex));
			expect(near[stretchIndex] === 1).toBe(expected.includes(stretchIndex));
		}
	});

	it("ramps into a lone hot stretch and back to zero within the fade", () => {
		const solve = new WindowedSolve({ peaks: hotPeaks() });
		const scoreHot = (threshold: number): Float64Array =>
			costTableOf(lastFrameCandidates([{ current: 1, dispersed: 0 }], threshold));

		expect(solve.seedStretch).toBe(HOT_STRETCH);

		solve.seed(scoreHot(solve.seedThreshold));

		expect(solve.threshold()).toBe(0.6);

		solveAroundHotStretch(solve, scoreHot);

		const expected = new Array<number>(STRETCH_COUNT + 1).fill(0);

		expected.splice(HOT_STRETCH - 2, 7, 1, 2, 3, 4, 3, 2, 1);

		expect(solve.level()).toBe(0.6);
		expect(Array.from(solve.path())).toEqual(expected);
	});

	it("raises the threshold to a scored stretch's lowest cost", () => {
		const solve = new WindowedSolve({ peaks: hotPeaks() });

		solve.seed(costTableOf(new Float64Array(0)));
		solve.advance(0, new Float64Array(PAIR_COUNT).fill(0.8));

		expect(solve.threshold()).toBe(0.8);
	});

	it("rejects a stretch past the last and a seed after advancing", () => {
		const solve = new WindowedSolve({ peaks: Float64Array.of(1) });
		const costs = costTableOf(new Float64Array(0));

		solve.advance(0, costs);

		expect(() => solve.advance(1, costs)).toThrow();
		expect(() => solve.seed(costs)).toThrow();
	});

	it("holds silence at level zero on an all-zero path", () => {
		const solve = new WindowedSolve({ peaks: new Float64Array(STRETCH_COUNT) });

		solve.seed(costTableOf(new Float64Array(0)));

		const near = solve.nearStretches();

		for (let stretchIndex = 0; stretchIndex < STRETCH_COUNT; stretchIndex++) {
			expect(near[stretchIndex]).toBe(0);
			solve.advance(stretchIndex, undefined);
		}

		expect(solve.level()).toBe(0);
		expect(Array.from(solve.path())).toEqual(new Array<number>(STRETCH_COUNT + 1).fill(0));
	});

	it("keeps the seed's lowest cost as the level when a re-score drops the sample that set it", () => {
		const solve = new WindowedSolve({ peaks: hotPeaks() });
		const scoreHot = (threshold: number): Float64Array =>
			costTableOf(
				lastFrameCandidates(
					[
						{ current: 1, dispersed: 0.69 },
						{ current: 0.6, dispersed: 0.7 },
					],
					threshold,
				),
			);

		solve.seed(scoreHot(solve.seedThreshold));

		expect(solve.threshold()).toBe(0.7);

		const rescored = scoreHot(solve.threshold());

		expect(Math.min(...rescored)).toBe(0.69);

		solveAroundHotStretch(solve, scoreHot);

		expect(solve.level()).toBe(0.7);
	});
});

describe("WindowedSolve against the whole-file oracle", () => {
	const ORACLE_STRETCH_FRAMES = 48;
	const ORACLE_STRETCH_COUNT = 200;
	const ORACLE_FRAMES = ORACLE_STRETCH_FRAMES * ORACLE_STRETCH_COUNT;
	const BURST_FRAMES = 6;
	const DISPERSION_DELAY = 2;

	const withBursts = (
		channels: Array<Float64Array>,
		bursts: ReadonlyArray<{ frame: number; amplitude: number; channel?: number }>,
	): Array<Float64Array> => {
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
		createNoise(ORACLE_FRAMES, channelCount, seed).map((channel) => channel.map((sample) => 0.1 * sample));

	const sparseBursts = (seed: number, count: number): Array<{ frame: number; amplitude: number }> => {
		let state = seed >>> 0;
		const next = (): number => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

			return state / 0x100000000;
		};

		return Array.from({ length: count }, () => ({
			frame: Math.floor(next() * (ORACLE_FRAMES - BURST_FRAMES)),
			amplitude: 0.4 + 0.5 * next(),
		}));
	};

	const delayed = (channel: Float64Array): Float64Array =>
		channel.map((_sample, frame) => (frame < DISPERSION_DELAY ? 0 : (channel[frame - DISPERSION_DELAY] ?? 0)));

	const expectUpsampledOracle = (args: {
		currentUpsampled: ReadonlyArray<Float64Array>;
		dispersedUpsampled: ReadonlyArray<Float64Array>;
		frameCount: number;
		stretchFrames: number;
	}): { readonly level: number; readonly path: Int32Array } => {
		const { currentUpsampled, dispersedUpsampled, frameCount, stretchFrames } = args;
		const stretchCount = Math.ceil(frameCount / stretchFrames);
		const peaks = new Float64Array(stretchCount);

		for (const channel of currentUpsampled) {
			for (let index = 0; index < frameCount * OVERSAMPLE_FACTOR; index++) {
				const stretchIndex = Math.floor(index / OVERSAMPLE_FACTOR / stretchFrames);

				peaks[stretchIndex] = Math.max(peaks[stretchIndex] ?? 0, Math.abs(channel[index] ?? 0));
			}
		}

		const stretchSamples = stretchFrames * OVERSAMPLE_FACTOR;
		const scoreAt = (stretchIndex: number, threshold: number): Float64Array =>
			costTableOf(
				candidatesOf({
					current: currentUpsampled.map((channel) =>
						channel.subarray(stretchIndex * stretchSamples, (stretchIndex + 1) * stretchSamples),
					),
					dispersed: dispersedUpsampled.map((channel) =>
						channel.subarray(stretchIndex * stretchSamples, (stretchIndex + 1) * stretchSamples),
					),
					frameCount: Math.min(stretchFrames, frameCount - stretchIndex * stretchFrames),
					stretchFrames,
					threshold,
				}),
			);
		const solve = new WindowedSolve({ peaks });

		solve.seed(scoreAt(solve.seedStretch, solve.seedThreshold));

		for (let stretchIndex = 0; stretchIndex < stretchCount; stretchIndex++) {
			solve.advance(stretchIndex, solve.isNear(stretchIndex) ? scoreAt(stretchIndex, solve.threshold()) : undefined);
		}

		const oracle = oracleOf({
			current: currentUpsampled,
			dispersed: dispersedUpsampled,
			frameCount,
			stretchFrames,
		});
		const level = solve.level();

		expect(level).toBe(oracle.level);
		expect(Array.from(solve.path())).toEqual(Array.from(oracle.path));

		for (let stretchIndex = 0; stretchIndex < stretchCount; stretchIndex++) {
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

		return { level, path: solve.path() };
	};

	const expectOracle = (current: ReadonlyArray<Float64Array>): { readonly level: number; readonly path: Int32Array } =>
		expectUpsampledOracle({
			currentUpsampled: current.map(upsampledOf),
			dispersedUpsampled: current.map((channel) => upsampledOf(delayed(channel))),
			frameCount: ORACLE_FRAMES,
			stretchFrames: ORACLE_STRETCH_FRAMES,
		});

	it("matches on seeded noise with sparse bursts", () => {
		expectOracle(withBursts(quietNoise(1, 41), sparseBursts(43, 12)));
	});

	it("matches on stereo with the loudest burst on the second channel alone", () => {
		const bursts = sparseBursts(43, 12);
		const { level } = expectOracle(
			withBursts(quietNoise(2, 41), [...bursts, { frame: 4000, amplitude: 1.1, channel: 1 }]),
		);

		expect(level).toBeGreaterThan(expectOracle(withBursts(quietNoise(2, 41), bursts)).level);
	});

	it("matches a lone peak that needs the full fade on both sides", () => {
		const frameCount = 41 * STRETCH_FRAMES;
		const currentUpsampled = new Float64Array((frameCount + FLUSH_FRAMES) * OVERSAMPLE_FACTOR);
		const dispersedUpsampled = new Float64Array((frameCount + FLUSH_FRAMES) * OVERSAMPLE_FACTOR);
		const peakIndex = 20 * STRETCH_FRAMES * OVERSAMPLE_FACTOR;

		currentUpsampled[peakIndex] = 1;
		dispersedUpsampled[peakIndex] = 0.65;

		const { level, path } = expectUpsampledOracle({
			currentUpsampled: [currentUpsampled],
			dispersedUpsampled: [dispersedUpsampled],
			frameCount,
			stretchFrames: STRETCH_FRAMES,
		});
		const expected = new Array<number>(42).fill(0);

		expected.splice(11, 20, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1);

		expect(level).toBeCloseTo(0.65, 15);
		expect(Array.from(path)).toEqual(expected);
	});

	it("matches with the same burst in every stretch", () => {
		expectOracle(
			withBursts(
				quietNoise(1, 47),
				Array.from({ length: ORACLE_STRETCH_COUNT }, (_burst, stretchIndex) => ({
					frame: stretchIndex * ORACLE_STRETCH_FRAMES + 20,
					amplitude: 0.8,
				})),
			),
		);
	});

	it("matches with the loudest burst in the last tenth", () => {
		expectOracle(
			withBursts(quietNoise(1, 53), [
				...sparseBursts(59, 10),
				{ frame: Math.floor(ORACLE_FRAMES * 0.95), amplitude: 1.2 },
			]),
		);
	});

	it("matches on silence", () => {
		expectOracle([new Float64Array(ORACLE_FRAMES)]);
	});
});
