import { chainLevelOf, chainWalkOf, type ChainRegion, type ChainTables } from "./chain";
import { stretchFrameCountOf, type CrestLayout } from "./ladder";
import { markFreeStretches, rangesOf, regionsOf, type StretchRange } from "./regions";
import {
	allocateChannels,
	forEachStretchChunk,
	measureStretch,
	renderStretch,
	OVERSAMPLE_FACTOR,
	TRUE_PEAK_TAIL_FRAMES,
	type StretchChunk,
	type StretchMeasure,
} from "./render";
import { printedDbOf, quantizerOf } from "./rounding";
import { beginStepIndexOf, endStepIndexOf, pairIndexOf, stepPairsOf, DELTA_COUNT } from "./walk";
import type { WavBitDepth } from "../../../wav/utils/wavFormat";

export interface CrestSolution {
	readonly walk: Int32Array;
	readonly level: number;
	readonly activeStretchCount: number;
	readonly widenCount: number;
}

interface SolveArguments {
	readonly inputPath: string;
	readonly layout: CrestLayout;
	readonly bitDepth: WavBitDepth;
	readonly channelCount: number;
}

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

const loudestStretchOf = (readings: Float64Array): number => {
	let loudest = 0;

	for (let stretchIndex = 0; stretchIndex < readings.length; stretchIndex++) {
		if ((readings[stretchIndex] ?? -Infinity) > (readings[loudest] ?? -Infinity)) {
			loudest = stretchIndex;
		}
	}

	return loudest;
};

const solveWithGate = async (args: SolveArguments, isGated: boolean): Promise<CrestSolution> => {
	const { layout, bitDepth, channelCount } = args;
	const pairs = stepPairsOf(layout.steps.length);
	const quantize = quantizerOf(bitDepth);
	const stride = OVERSAMPLE_FACTOR * channelCount;
	const reachStretches = (layout.steps.length - 1) / 2;
	const everyStepIndex = layout.steps.map((_step, stepIndex) => stepIndex);
	const sourceFrames = allocateChannels(channelCount, layout.stretchFrames);
	const outputFrames = allocateChannels(channelCount, layout.stretchFrames);
	const scratch = new Float64Array(layout.stretchFrames * OVERSAMPLE_FACTOR);
	const tailScratch = new Float64Array(TRUE_PEAK_TAIL_FRAMES * OVERSAMPLE_FACTOR);
	const values = new Float64Array(stride);
	const readings = new Float64Array(layout.stretchCount);
	const soloLevels = new Map<number, Float64Array>();
	const levels = new Map<number, Float64Array>();
	const identicalFrames = new Map<number, Int32Array>();
	const tables: ChainTables = {
		pairs,
		zeroPairIndex: pairIndexOf(layout.zeroStepIndex, layout.zeroStepIndex),
		readings,
		soloLevels,
		levels,
		identicalFrames,
	};

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

	const measureAllPairs = (chunk: StretchChunk, stretchIndex: number): Array<StretchMeasure | undefined> => {
		const frameCount = stretchFrameCountOf(layout, stretchIndex);
		const measures: Array<StretchMeasure | undefined> = [];

		renderStretch({
			chunk,
			layout,
			stretchIndex,
			beginStepIndex: layout.zeroStepIndex,
			endStepIndex: layout.zeroStepIndex,
			quantize,
			output: sourceFrames,
		});

		for (let pairIndex = 0; pairIndex < pairs.pairCount; pairIndex++) {
			if (pairs.isAdmissible[pairIndex] !== 1) {
				measures.push(undefined);

				continue;
			}

			renderStretch({
				chunk,
				layout,
				stretchIndex,
				beginStepIndex: beginStepIndexOf(pairIndex),
				endStepIndex: endStepIndexOf(pairIndex),
				quantize,
				output: outputFrames,
			});
			measures.push(measureStretch({ output: outputFrames, sourceFrames, frameCount, scratch, tailScratch }));
		}

		return measures;
	};

	const storeTables = (
		stretchIndex: number,
		measures: ReadonlyArray<StretchMeasure | undefined>,
		previousMeasures: ReadonlyArray<StretchMeasure | undefined> | undefined,
	): void => {
		const positions = windowPositionsOf(layout, stretchIndex);

		if (!soloLevels.has(stretchIndex)) {
			const solo = new Float64Array(pairs.pairCount).fill(Infinity);
			const counts = new Int32Array(pairs.pairCount);

			for (let pairIndex = 0; pairIndex < pairs.pairCount; pairIndex++) {
				const measure = measures[pairIndex];

				if (measure === undefined) {
					continue;
				}

				solo[pairIndex] = printedDbOf(chargeOf(stretchIndex, positions, measure, undefined));
				counts[pairIndex] = measure.identicalFrames;
			}

			soloLevels.set(stretchIndex, solo);
			identicalFrames.set(stretchIndex, counts);
		}

		if (previousMeasures === undefined || levels.has(stretchIndex)) {
			return;
		}

		const stretchLevels = new Float64Array(pairs.pairCount * DELTA_COUNT).fill(Infinity);

		for (let carryPair = 0; carryPair < pairs.pairCount; carryPair++) {
			const previousMeasure = previousMeasures[carryPair];

			if (previousMeasure === undefined) {
				continue;
			}

			for (let code = 0; code < DELTA_COUNT; code++) {
				const pairIndex = pairs.successorPair[carryPair * DELTA_COUNT + code] ?? -1;
				const measure = pairIndex < 0 ? undefined : measures[pairIndex];

				if (measure === undefined) {
					continue;
				}

				stretchLevels[carryPair * DELTA_COUNT + code] = printedDbOf(
					chargeOf(stretchIndex, positions, measure, previousMeasure),
				);
			}
		}

		levels.set(stretchIndex, stretchLevels);
	};

	const meterSource = async (): Promise<void> => {
		let previousMeasure: StretchMeasure | undefined;

		await forEachStretchChunk({
			path: args.inputPath,
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
	};

	const measureRegions = async (regions: ReadonlyArray<StretchRange>): Promise<void> => {
		const pending = new Set<number>();

		for (const region of regions) {
			for (let stretchIndex = region.firstStretch; stretchIndex <= region.lastStretch; stretchIndex++) {
				if (!soloLevels.has(stretchIndex)) {
					pending.add(stretchIndex);
				}

				if (stretchIndex > region.firstStretch && !levels.has(stretchIndex)) {
					pending.add(stretchIndex - 1);
					pending.add(stretchIndex);
				}
			}
		}

		if (pending.size === 0) {
			return;
		}

		let measuredIndex = -1;
		let measures: Array<StretchMeasure | undefined> = [];

		await forEachStretchChunk({
			path: args.inputPath,
			layout,
			ranges: rangesOf([...pending].sort((first, second) => first - second)),
			stepIndicesOf: () => everyStepIndex,
			handle: (chunk) => {
				for (let offset = 0; offset < chunk.stretchCount; offset++) {
					const stretchIndex = chunk.firstStretch + offset;
					const stretchMeasures = measureAllPairs(chunk, stretchIndex);

					storeTables(stretchIndex, stretchMeasures, measuredIndex === stretchIndex - 1 ? measures : undefined);
					measuredIndex = stretchIndex;
					measures = stretchMeasures;
				}
			},
		});
	};

	await meterSource();

	if (layout.stretchCount === 0) {
		return { walk: new Int32Array(1), level: printedDbOf(0), activeStretchCount: 0, widenCount: 0 };
	}

	const isFree = new Uint8Array(layout.stretchCount);
	const chainRegionOf = (region: StretchRange): ChainRegion => ({
		firstStretch: region.firstStretch,
		lastStretch: region.lastStretch,
		leftFree: region.firstStretch === 0,
		rightFree: region.lastStretch === layout.stretchCount - 1,
	});
	const openGate = async (): Promise<{ regions: Array<StretchRange>; level: number; widenCount: number }> => {
		let regions = regionsOf(isFree);
		let widenCount = 0;

		for (;;) {
			await measureRegions(regions);

			const regionLevels = regions.map((region) => chainLevelOf(tables, chainRegionOf(region)));
			let hasWidened = false;

			for (let index = 0; index < regions.length; index++) {
				const region = regions[index];

				if (region === undefined) {
					continue;
				}

				const bound = chainLevelOf(tables, { ...chainRegionOf(region), leftFree: true, rightFree: true });

				if (bound < (regionLevels[index] ?? Infinity)) {
					markFreeStretches(isFree, region.firstStretch - reachStretches, region.lastStretch + reachStretches);
					widenCount += 1;
					hasWidened = true;
				}
			}

			if (hasWidened) {
				regions = regionsOf(isFree);

				continue;
			}

			let level = -Infinity;

			for (const regionLevel of regionLevels) {
				level = Math.max(level, regionLevel);
			}

			const hotStretches: Array<number> = [];

			for (let stretchIndex = 0; stretchIndex < layout.stretchCount; stretchIndex++) {
				if (isFree[stretchIndex] !== 1 && (readings[stretchIndex] ?? -Infinity) > level) {
					hotStretches.push(stretchIndex);
				}
			}

			if (hotStretches.length === 0) {
				return { regions, level, widenCount };
			}

			for (const stretchIndex of hotStretches) {
				markFreeStretches(isFree, stretchIndex - reachStretches, stretchIndex + reachStretches);
			}

			regions = regionsOf(isFree);
		}
	};

	if (isGated) {
		const loudest = loudestStretchOf(readings);

		markFreeStretches(isFree, loudest - reachStretches, loudest + reachStretches);
	} else {
		isFree.fill(1);
	}

	const gate = await openGate();

	for (const region of gate.regions) {
		markFreeStretches(isFree, region.firstStretch - reachStretches, region.lastStretch + reachStretches);
	}

	const regions = regionsOf(isFree);

	await measureRegions(regions);

	const walk = new Int32Array(layout.stretchCount + 1).fill(layout.zeroStepIndex);
	let level = -Infinity;
	let activeStretchCount = 0;

	for (const region of regions) {
		level = Math.max(level, chainLevelOf(tables, chainRegionOf(region)));
	}

	for (const region of regions) {
		const joins = chainWalkOf(tables, chainRegionOf(region), level);

		for (let offset = 0; offset < joins.length; offset++) {
			walk[region.firstStretch + offset] = joins[offset] ?? layout.zeroStepIndex;
		}

		activeStretchCount += region.lastStretch - region.firstStretch + 1;
	}

	return { walk, level, activeStretchCount, widenCount: gate.widenCount };
};

export const solveCrest = async (args: SolveArguments): Promise<CrestSolution> => solveWithGate(args, true);

export const solveCrestUngated = async (args: SolveArguments): Promise<CrestSolution> => solveWithGate(args, false);
