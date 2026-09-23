import { IntegratedLufsAccumulator } from "../../../measurement/IntegratedLufsAccumulator";
import { computeLoudnessRange } from "../../../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../../../measurement/ShortTermLoudnessAccumulator";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { linearToDb } from "../../../utils/db";
import { SampleFile } from "../../../utils/SampleFile";
import { forEachEnvelopedBlock } from "./apply";
import { gainDbAt } from "./curve";
import { renderEnvelope } from "./envelope";
import { holdHalfWidthOf, windowSamplesFromMs } from "./window";
import type { Anchors } from "./curve";
import type { DetectionHistogram } from "./measureSource";
import type { Scratch } from "../../../utils/Scratch";

export const BOOST_LOWER_BOUND = -30;
export const BOOST_UPPER_BOUND = 30;

const LINEAR_AMPLITUDE_EPSILON = 1e-12;
const LIMIT_EPSILON_DB = 0.01;
const CHECK_GRAIN_DB = 0.01;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_TOLERANCE = 0.5;
const MAX_BISECT_ITERATIONS = 50;

export interface IterationAttempt {
	boost: number;
	limitDb: number;
	lufsErr: number | null;
	outputLufs: number;
	outputTruePeakDb: number;
	outputLra: number;
	peakGainDb: number;
	peakErr: number | null;
}

export type Targets =
	| { readonly targetLufs: number; readonly targetTp: number | undefined }
	| { readonly targetLufs: undefined; readonly targetTp: number };

export interface IterateResult {
	bestSmoothedEnvelope: SampleFile;
	bestB: number;
	bestLimitDb: number;
	bestPeakGainDb: number;
	attempts: ReadonlyArray<IterationAttempt>;
	converged: boolean;
	winnerOutputLufs: number | null;
	winnerOutputTruePeakDb: number | null;
	winnerOutputLra: number | null;
}

export const predictOutputLufs = (sourceLufs: number, anchors: Anchors, histogram: DetectionHistogram): number => {
	const { heldEnergy, heldBucketMax, totalSamples } = histogram;
	const bucketCount = heldEnergy.length;

	if (bucketCount === 0 || heldBucketMax <= 0 || totalSamples === 0) {
		return -Infinity;
	}

	if (!Number.isFinite(sourceLufs)) {
		return -Infinity;
	}

	const bucketWidth = heldBucketMax / bucketCount;
	let weightedGainEnergy = 0;
	let weightedSourceEnergy = 0;

	for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
		const energy = heldEnergy[bucketIndex] ?? 0;

		if (energy === 0) {
			continue;
		}

		const centreLinear = (bucketIndex + 0.5) * bucketWidth;

		if (centreLinear < LINEAR_AMPLITUDE_EPSILON) {
			continue;
		}

		const centreDb = 20 * Math.log10(centreLinear);
		const gainDb = gainDbAt(centreDb, anchors);
		const gainLinear = Math.pow(10, gainDb / 20);

		weightedSourceEnergy += energy;
		weightedGainEnergy += energy * gainLinear * gainLinear;
	}

	if (weightedSourceEnergy <= 0 || weightedGainEnergy <= 0) {
		return -Infinity;
	}

	return sourceLufs + 10 * Math.log10(weightedGainEnergy / weightedSourceEnergy);
};

export const assignPeakGainDb = (boost: number, tpCap: number | null, neverExpand: boolean): number => {
	if (tpCap === null) {
		return boost;
	}

	return neverExpand ? Math.min(boost, tpCap) : tpCap;
};

const truePeakResidual = (outputTruePeakDb: number, limitDb: number, peakGainDb: number): number =>
	outputTruePeakDb - (limitDb + peakGainDb);

const bisectRoot = (args: {
	lower: number;
	upper: number;
	lowerError: number;
	errorAt: (candidate: number) => number;
	tolerance: number;
}): number => {
	const { errorAt, tolerance } = args;
	let { lower, upper } = args;
	let best = lower;
	let bestAbsError = Math.abs(args.lowerError);
	let workingLowerError = args.lowerError;
	const subToleranceBracket = tolerance / 100;

	for (let iteration = 0; iteration < MAX_BISECT_ITERATIONS; iteration++) {
		const mid = 0.5 * (lower + upper);
		const midError = errorAt(mid);

		if (Math.abs(midError) < bestAbsError || iteration === 0) {
			best = mid;
			bestAbsError = Math.abs(midError);
		}

		if (!Number.isFinite(midError) || Math.sign(midError) === Math.sign(workingLowerError)) {
			lower = mid;
			workingLowerError = midError;
		} else {
			upper = mid;
		}

		if (upper - lower < subToleranceBracket) {
			break;
		}
	}

	return best;
};

export const bisectBForTargetLufs = (args: {
	sourceLufs: number;
	targetLufs: number;
	anchors: Pick<Anchors, "floorDb" | "pivotDb" | "limitDb">;
	histogram: DetectionHistogram;
	tpCap: number | null;
	neverExpand: boolean;
	residual: number;
	tolerance: number;
}): number => {
	const { sourceLufs, targetLufs, anchors: anchorBase, histogram, tpCap, neverExpand, residual, tolerance } = args;

	if (!Number.isFinite(sourceLufs)) {
		return 0;
	}

	const predictAt = (candidateB: number): number => {
		const candidateAnchors: Anchors = {
			floorDb: anchorBase.floorDb,
			pivotDb: anchorBase.pivotDb,
			limitDb: anchorBase.limitDb,
			B: candidateB,
			peakGainDb: assignPeakGainDb(candidateB, tpCap, neverExpand),
		};

		return predictOutputLufs(sourceLufs, candidateAnchors, histogram) + residual;
	};

	const lower = BOOST_LOWER_BOUND;
	const upper = BOOST_UPPER_BOUND;
	const lowerLufs = predictAt(lower);
	const upperLufs = predictAt(upper);
	const lowerError = lowerLufs - targetLufs;
	const upperError = upperLufs - targetLufs;

	if (
		!Number.isFinite(lowerError) ||
		!Number.isFinite(upperError) ||
		Math.sign(lowerError) === Math.sign(upperError)
	) {
		const lowerAbs = Number.isFinite(lowerError) ? Math.abs(lowerError) : Infinity;
		const upperAbs = Number.isFinite(upperError) ? Math.abs(upperError) : Infinity;

		return lowerAbs <= upperAbs ? lower : upper;
	}

	return bisectRoot({
		lower,
		upper,
		lowerError,
		errorAt: (candidateB) => predictAt(candidateB) - targetLufs,
		tolerance,
	});
};

export const bisectPeakGainForTargetLufs = (args: {
	sourceLufs: number;
	targetLufs: number;
	anchors: Omit<Anchors, "peakGainDb">;
	histogram: DetectionHistogram;
	ceilingPeakGainDb: number;
	residual: number;
	tolerance: number;
}): number => {
	const { sourceLufs, targetLufs, anchors: anchorBase, histogram, ceilingPeakGainDb, residual, tolerance } = args;
	const errorAt = (candidatePeakGainDb: number): number =>
		predictOutputLufs(sourceLufs, { ...anchorBase, peakGainDb: candidatePeakGainDb }, histogram) +
		residual -
		targetLufs;
	const ceilingError = errorAt(ceilingPeakGainDb);

	if (!(ceilingError > 0) || ceilingPeakGainDb <= BOOST_LOWER_BOUND) {
		return ceilingPeakGainDb;
	}

	const lowerError = errorAt(BOOST_LOWER_BOUND);

	if (!(lowerError <= 0)) {
		return BOOST_LOWER_BOUND;
	}

	return bisectRoot({ lower: BOOST_LOWER_BOUND, upper: ceilingPeakGainDb, lowerError, errorAt, tolerance });
};

const grainedDb = (errorDb: number): number => Math.round(errorDb / CHECK_GRAIN_DB) * CHECK_GRAIN_DB;

export const holdsTruePeak = (outputTruePeakDb: number, targetTp: number | undefined): boolean =>
	targetTp === undefined || grainedDb(outputTruePeakDb - targetTp) <= 0;

export const isLegalAttempt = (
	outputLufs: number,
	outputTruePeakDb: number,
	targetLufs: number | undefined,
	targetTp: number | undefined,
): boolean =>
	(targetLufs === undefined || grainedDb(outputLufs - targetLufs) <= 0) && holdsTruePeak(outputTruePeakDb, targetTp);

type AttemptOutput = Pick<IterationAttempt, "outputLufs" | "outputTruePeakDb">;

const distanceOf = (value: number, target: number | undefined): number =>
	target === undefined ? 0 : Math.abs(value - target);

const landsCloser = (
	candidate: AttemptOutput,
	winner: AttemptOutput,
	targetLufs: number | undefined,
	targetTp: number | undefined,
): boolean =>
	targetLufs === undefined
		? distanceOf(candidate.outputTruePeakDb, targetTp) < distanceOf(winner.outputTruePeakDb, targetTp)
		: distanceOf(candidate.outputLufs, targetLufs) < distanceOf(winner.outputLufs, targetLufs);

export const attemptBeatsWinner = (
	candidate: AttemptOutput,
	winner: AttemptOutput | undefined,
	targetLufs: number | undefined,
	targetTp: number | undefined,
): boolean => {
	if (winner === undefined) {
		return true;
	}

	const candidateLegal = isLegalAttempt(candidate.outputLufs, candidate.outputTruePeakDb, targetLufs, targetTp);
	const winnerLegal = isLegalAttempt(winner.outputLufs, winner.outputTruePeakDb, targetLufs, targetTp);

	if (candidateLegal !== winnerLegal) {
		return candidateLegal;
	}

	if (candidateLegal) {
		return landsCloser(candidate, winner, targetLufs, targetTp);
	}

	const candidateHoldsTp = holdsTruePeak(candidate.outputTruePeakDb, targetTp);
	const winnerHoldsTp = holdsTruePeak(winner.outputTruePeakDb, targetTp);

	if (candidateHoldsTp !== winnerHoldsTp) {
		return candidateHoldsTp;
	}

	if (candidateHoldsTp) {
		return landsCloser(candidate, winner, targetLufs, targetTp);
	}

	const candidatePeakDistance = distanceOf(candidate.outputTruePeakDb, targetTp);
	const winnerPeakDistance = distanceOf(winner.outputTruePeakDb, targetTp);

	if (candidatePeakDistance !== winnerPeakDistance) {
		return candidatePeakDistance < winnerPeakDistance;
	}

	return distanceOf(candidate.outputLufs, targetLufs) < distanceOf(winner.outputLufs, targetLufs);
};

const nextSearchBoost = (
	attempts: ReadonlyArray<IterationAttempt>,
	residualBoost: number,
	targetLufs: number,
): number => {
	let highestUnderBoost: number | undefined;
	let lowestOverBoost: number | undefined;

	for (const attempt of attempts) {
		if (attempt.outputLufs <= targetLufs) {
			if (highestUnderBoost === undefined || attempt.boost > highestUnderBoost) {
				highestUnderBoost = attempt.boost;
			}
		} else if (lowestOverBoost === undefined || attempt.boost < lowestOverBoost) {
			lowestOverBoost = attempt.boost;
		}
	}

	if (highestUnderBoost !== undefined && lowestOverBoost !== undefined && highestUnderBoost < lowestOverBoost) {
		return 0.5 * (highestUnderBoost + lowestOverBoost);
	}

	return residualBoost;
};

const clampBoost = (boost: number): number => {
	if (!Number.isFinite(boost)) {
		return 0;
	}

	if (boost < BOOST_LOWER_BOUND) {
		return BOOST_LOWER_BOUND;
	}

	if (boost > BOOST_UPPER_BOUND) {
		return BOOST_UPPER_BOUND;
	}

	return boost;
};

const clampLimit = (limitDb: number, pivotDb: number, sourcePeakDb: number): number => {
	if (!Number.isFinite(limitDb)) {
		return sourcePeakDb;
	}

	const lower = pivotDb + LIMIT_EPSILON_DB;

	if (lower > sourcePeakDb) {
		return sourcePeakDb;
	}

	if (limitDb < lower) {
		return lower;
	}

	if (limitDb > sourcePeakDb) {
		return sourcePeakDb;
	}

	return limitDb;
};

const measureAttemptOutput = async (args: {
	inputPath: string;
	sampleRate: number;
	channelCount: number;
	envelope: SampleFile;
}): Promise<{ outputLufs: number; outputLra: number; outputTruePeakDb: number }> => {
	const { inputPath, sampleRate, channelCount, envelope } = args;
	const lufsAccumulator = new IntegratedLufsAccumulator(sampleRate, channelCount);
	const shortTermAccumulator = new ShortTermLoudnessAccumulator(sampleRate, channelCount);
	const truePeakAccumulator = new TruePeakAccumulator(channelCount);

	await forEachEnvelopedBlock(inputPath, envelope, (channels, frameCount) => {
		lufsAccumulator.push(channels, frameCount);
		shortTermAccumulator.push(channels, frameCount);
		truePeakAccumulator.push(channels, frameCount);
	});

	const shortTerm = shortTermAccumulator.finalize();

	return {
		outputLufs: lufsAccumulator.finalize(),
		outputLra: shortTerm.length === 0 ? 0 : computeLoudnessRange(shortTerm),
		outputTruePeakDb: linearToDb(truePeakAccumulator.finalize()),
	};
};

export const iterateForTargets = async (
	args: {
		inputPath: string;
		scratch: Scratch;
		sampleRate: number;
		channelCount: number;
		frameCount: number;
		anchorBase: { floorDb: number | null; pivotDb: number };
		smoothingMs: number;
		limitDbOverride?: number;
		limitAutoDb: number;
		sourceLufs: number;
		sourcePeakDb: number;
		maxAttempts?: number;
		tolerance?: number;
		neverExpand: boolean;
		histogram: DetectionHistogram;
		detectionEnvelope: SampleFile;
		onAttempt?: (attempt: IterationAttempt, attemptIndex: number) => void;
	} & Targets,
): Promise<IterateResult> => {
	const {
		inputPath,
		scratch,
		sampleRate,
		channelCount,
		frameCount,
		anchorBase,
		smoothingMs,
		targetLufs,
		targetTp,
		limitDbOverride,
		limitAutoDb,
		sourceLufs,
		sourcePeakDb,
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		tolerance = DEFAULT_TOLERANCE,
		neverExpand,
		histogram,
		detectionEnvelope,
		onAttempt,
	} = args;

	if (channelCount === 0 || frameCount === 0) {
		await detectionEnvelope.close();

		return {
			bestSmoothedEnvelope: await SampleFile.create(scratch, "empty-envelope"),
			bestB: 0,
			bestLimitDb: sourcePeakDb,
			bestPeakGainDb: 0,
			attempts: [],
			converged: false,
			winnerOutputLufs: null,
			winnerOutputTruePeakDb: null,
			winnerOutputLra: null,
		};
	}

	let currentLimit: number;

	if (limitDbOverride !== undefined) {
		currentLimit = clampLimit(limitDbOverride, anchorBase.pivotDb, sourcePeakDb);
	} else if (Number.isFinite(limitAutoDb)) {
		currentLimit = clampLimit(limitAutoDb, anchorBase.pivotDb, sourcePeakDb);
	} else {
		currentLimit = sourcePeakDb;
	}

	const holdHalfWidth = holdHalfWidthOf(windowSamplesFromMs(smoothingMs, sampleRate));
	let residual = 0;
	let peakResidual = 0;
	const attempts: Array<IterationAttempt> = [];
	const tpCapAt = (tp: number): number => tp - currentLimit - peakResidual;
	const tpCapOf = (): number | null => (targetTp === undefined ? null : tpCapAt(targetTp));
	const lufsBoostOf = (lufs: number): number =>
		bisectBForTargetLufs({
			sourceLufs,
			targetLufs: lufs,
			anchors: { floorDb: anchorBase.floorDb, pivotDb: anchorBase.pivotDb, limitDb: currentLimit },
			histogram,
			tpCap: tpCapOf(),
			neverExpand,
			residual,
			tolerance,
		});
	const boostOf = (): number =>
		args.targetLufs === undefined
			? tpCapAt(args.targetTp)
			: clampBoost(nextSearchBoost(attempts, lufsBoostOf(args.targetLufs), args.targetLufs));
	const peakGainDbOf = (boost: number): number => {
		const ceilingPeakGainDb = assignPeakGainDb(boost, tpCapOf(), neverExpand);

		if (targetLufs === undefined || targetTp === undefined || boost !== BOOST_LOWER_BOUND) {
			return ceilingPeakGainDb;
		}

		return bisectPeakGainForTargetLufs({
			sourceLufs,
			targetLufs,
			anchors: { floorDb: anchorBase.floorDb, pivotDb: anchorBase.pivotDb, limitDb: currentLimit, B: boost },
			histogram,
			ceilingPeakGainDb,
			residual,
			tolerance,
		});
	};
	const hasConverged = (attempt: IterationAttempt | undefined): boolean => {
		if (attempt === undefined) {
			return false;
		}

		const landingError = attempt.lufsErr ?? attempt.peakErr;

		return (
			landingError !== null &&
			isLegalAttempt(attempt.outputLufs, attempt.outputTruePeakDb, targetLufs, targetTp) &&
			Math.abs(grainedDb(landingError)) < tolerance
		);
	};
	let currentBoost = boostOf();
	let currentPeakGainDb = peakGainDbOf(currentBoost);
	let winningAttempt: IterationAttempt | undefined;
	let bestBoost = currentBoost;
	let bestPeakGainDb = currentPeakGainDb;
	let winnerOutputLufs: number | null = null;
	let winnerOutputTruePeakDb: number | null = null;
	let winnerOutputLra: number | null = null;
	let winningEnvelope: SampleFile | undefined;

	try {
		for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
			const anchors: Anchors = {
				floorDb: anchorBase.floorDb,
				pivotDb: anchorBase.pivotDb,
				limitDb: currentLimit,
				B: currentBoost,
				peakGainDb: currentPeakGainDb,
			};
			const predictedLufs = predictOutputLufs(sourceLufs, anchors, histogram);
			const dest = await SampleFile.create(scratch, `envelope-${attemptIndex}`);
			let measured: { outputLufs: number; outputLra: number; outputTruePeakDb: number };

			try {
				await renderEnvelope({ detectionEnvelope, dest, anchors, holdHalfWidth });
				measured = await measureAttemptOutput({
					inputPath,
					sampleRate,
					channelCount,
					envelope: dest,
				});
			} catch (error: unknown) {
				await dest.close();

				throw error;
			}

			const attempt: IterationAttempt = {
				boost: currentBoost,
				limitDb: currentLimit,
				lufsErr: targetLufs === undefined ? null : measured.outputLufs - targetLufs,
				outputLufs: measured.outputLufs,
				outputTruePeakDb: measured.outputTruePeakDb,
				outputLra: measured.outputLra,
				peakGainDb: currentPeakGainDb,
				peakErr: targetTp === undefined ? null : measured.outputTruePeakDb - targetTp,
			};

			attempts.push(attempt);
			onAttempt?.(attempt, attemptIndex);

			if (attemptBeatsWinner(attempt, winningAttempt, targetLufs, targetTp)) {
				winningAttempt = attempt;
				bestBoost = currentBoost;
				bestPeakGainDb = currentPeakGainDb;
				winnerOutputLufs = measured.outputLufs;
				winnerOutputTruePeakDb = measured.outputTruePeakDb;
				winnerOutputLra = measured.outputLra;

				const previousWinner = winningEnvelope;

				winningEnvelope = dest;

				if (previousWinner !== undefined) {
					await previousWinner.close();
				}
			} else {
				await dest.close();
			}

			residual = measured.outputLufs - predictedLufs;
			peakResidual = truePeakResidual(measured.outputTruePeakDb, currentLimit, currentPeakGainDb);

			const boostBoundExhausted =
				targetLufs !== undefined &&
				((currentBoost === BOOST_UPPER_BOUND && measured.outputLufs < targetLufs) ||
					(currentBoost === BOOST_LOWER_BOUND &&
						currentPeakGainDb <= BOOST_LOWER_BOUND &&
						measured.outputLufs > targetLufs));

			if (
				hasConverged(winningAttempt) ||
				(boostBoundExhausted && holdsTruePeak(measured.outputTruePeakDb, targetTp)) ||
				attemptIndex === maxAttempts - 1
			) {
				break;
			}

			currentBoost = boostOf();
			currentPeakGainDb = peakGainDbOf(currentBoost);
		}

		const converged = hasConverged(winningAttempt);

		const result: IterateResult = {
			bestSmoothedEnvelope: winningEnvelope ?? (await SampleFile.create(scratch, "empty-envelope")),
			bestB: bestBoost,
			bestLimitDb: currentLimit,
			bestPeakGainDb,
			attempts,
			converged,
			winnerOutputLufs,
			winnerOutputTruePeakDb,
			winnerOutputLra,
		};

		winningEnvelope = undefined;

		return result;
	} finally {
		try {
			await winningEnvelope?.close();
		} finally {
			await detectionEnvelope.close();
		}
	}
};
