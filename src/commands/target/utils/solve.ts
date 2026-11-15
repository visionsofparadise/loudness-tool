import { IntegratedLufsAccumulator } from "../../../measurement/IntegratedLufsAccumulator";
import { computeLoudnessRange } from "../../../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../../../measurement/ShortTermLoudnessAccumulator";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { DEFAULT_OVERSAMPLING, type OversamplingFactor } from "../../../measurement/TruePeakUpsampler";
import { linearToDb, lufsOrNull, peakDbOrNull } from "../../../utils/db";
import { SampleFile } from "../../../utils/SampleFile";
import { quantizerOf } from "../../../wav/utils/sampleCodec";
import { forEachEnvelopedBlock } from "./apply";
import { gainDbAt } from "./curve";
import { renderEnvelope } from "./envelope";
import { CELL_COUNT, cellCentreDb, cellOf, cellShareAtOrAbove } from "./measureSource";
import { holdHalfWidthOf, windowSamplesFromMs } from "./window";
import type { Anchors } from "./curve";
import type { DetectionHistogram } from "./measureSource";
import type { Scratch } from "../../../utils/Scratch";
import type { SourceBitDepth } from "../../../wav/utils/wavFormat";

const DEFAULT_CEILING_DB = 0;

const CHECK_GRAIN_DB = 0.01;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_TOLERANCE = 0.5;
const MAX_BISECT_ITERATIONS = 50;
const BRACKET_STEP_DB = 6;
const MAX_BRACKET_STEPS = 64;
const MIN_OVERSHOOT_SLOPE = 0.01;
const OVERSHOOT_STEP_DB = 1;
const LEGALITY_ATTEMPT_LIMIT = 20;
const REPEAT_GRAIN_DB = 1e-4;

export interface IterationAttempt {
	boost: number;
	peakGainDb: number | null;
	ceilingDb: number;
	lufsErr: number | null;
	peakErr: number | null;
	outputLufs: number | null;
	outputTruePeakDb: number | null;
	outputLra: number | null;
}

export type Targets =
	| { readonly targetLufs: number; readonly targetTp: number | undefined }
	| { readonly targetLufs: undefined; readonly targetTp: number };

export interface IterateResult {
	bestSmoothedEnvelope: SampleFile;
	bestB: number;
	bestPeakGainDb: number | null;
	attempts: ReadonlyArray<IterationAttempt>;
	converged: boolean;
	unreachableLufs: number | null;
	unreachableCause: UnreachableCause | null;
	winnerOutputLufs: number | null;
	winnerOutputTruePeakDb: number | null;
	winnerOutputLra: number | null;
}

export type UnreachableCause = "body-limit" | "stops-rising";

export interface SearchCap {
	readonly boost: number;
	readonly cause: UnreachableCause;
}

export interface AnchorBase {
	readonly floorDb: number | null;
	readonly pivotDb: number;
	readonly kneeDb: number | null;
	readonly limitDb: number;
}

export const predictOutputLufs = (sourceLufs: number, anchors: Anchors, histogram: DetectionHistogram): number => {
	if (!Number.isFinite(sourceLufs)) {
		return -Infinity;
	}

	const { energy } = histogram;
	let sourceEnergy = 0;
	let outputEnergy = 0;

	for (let loudnessCell = 0; loudnessCell < CELL_COUNT; loudnessCell++) {
		const row = loudnessCell * CELL_COUNT;
		const loudnessDb = cellCentreDb(loudnessCell);

		for (let peakCell = 0; peakCell < CELL_COUNT; peakCell++) {
			const cellEnergy = energy[row + peakCell] ?? 0;

			if (cellEnergy === 0) {
				continue;
			}

			sourceEnergy += cellEnergy;
			outputEnergy += cellEnergy * Math.pow(10, gainDbAt(loudnessDb, cellCentreDb(peakCell), anchors) / 10);
		}
	}

	if (sourceEnergy <= 0 || outputEnergy <= 0) {
		return -Infinity;
	}

	return sourceLufs + 10 * Math.log10(outputEnergy / sourceEnergy);
};

const peakGainDbOf = (args: { boost: number; ceilingDb: number; limitDb: number; expansionDb: number }): number =>
	Math.min(args.ceilingDb - args.limitDb, args.boost + args.expansionDb);

export const bracketBoost = (args: {
	predict: (B: number) => number;
	targetLufs: number;
	startB: number;
	maxB: number;
	tolerance: number;
}):
	| { readonly kind: "bracket"; readonly lower: number; readonly upper: number }
	| { readonly kind: "capped"; readonly boost: number } => {
	const { predict, targetLufs, maxB, tolerance } = args;
	const startB = Math.min(args.startB, maxB);
	const startLufs = predict(startB);

	if (startLufs === targetLufs) {
		return { kind: "bracket", lower: startB, upper: startB };
	}

	const direction = startLufs < targetLufs ? 1 : -1;

	if (direction > 0 && startB === maxB) {
		return { kind: "capped", boost: maxB };
	}

	let previousB = startB;
	let previousLufs = startLufs;
	let step = BRACKET_STEP_DB;

	for (let stepIndex = 0; stepIndex < MAX_BRACKET_STEPS; stepIndex++) {
		const candidateB = direction > 0 ? Math.min(maxB, previousB + step) : previousB - step;
		const candidateLufs = predict(candidateB);

		if (direction > 0 ? candidateLufs >= targetLufs : candidateLufs <= targetLufs) {
			return {
				kind: "bracket",
				lower: Math.min(previousB, candidateB),
				upper: Math.max(previousB, candidateB),
			};
		}

		if (direction > 0 && (candidateB === maxB || !(candidateLufs - previousLufs >= tolerance / 10))) {
			return { kind: "capped", boost: candidateB };
		}

		previousB = candidateB;
		previousLufs = candidateLufs;
		step *= 2;
	}

	return { kind: "capped", boost: previousB };
};

export const bodySaturationBoost = (args: {
	anchorsAt: (B: number) => Anchors;
	histogram: DetectionHistogram;
	startB: number;
	tolerance: number;
}): number => {
	const { anchorsAt, histogram, startB, tolerance } = args;
	const { pivotDb } = anchorsAt(startB);
	const pivotCell = cellOf(pivotDb);
	const pivotCellShare = cellShareAtOrAbove(pivotDb);
	const bodyCells: Array<{ readonly loudnessDb: number; readonly peakDb: number; readonly energy: number }> = [];

	for (let loudnessCell = pivotCell; loudnessCell < CELL_COUNT; loudnessCell++) {
		const share = loudnessCell === pivotCell ? pivotCellShare : 1;

		for (let peakCell = 0; peakCell < CELL_COUNT; peakCell++) {
			const energy = share * (histogram.energy[loudnessCell * CELL_COUNT + peakCell] ?? 0);

			if (energy > 0) {
				bodyCells.push({ loudnessDb: cellCentreDb(loudnessCell), peakDb: cellCentreDb(peakCell), energy });
			}
		}
	}

	if (bodyCells.length === 0) {
		return Number.POSITIVE_INFINITY;
	}

	const bodyLevelAt = (boost: number): number => {
		const anchors = anchorsAt(boost);
		let energy = 0;

		for (const cell of bodyCells) {
			energy += cell.energy * Math.pow(10, gainDbAt(cell.loudnessDb, cell.peakDb, anchors) / 10);
		}

		return 10 * Math.log10(energy);
	};
	const isSaturated = (boost: number): boolean =>
		bodyLevelAt(boost + BRACKET_STEP_DB) - bodyLevelAt(boost) < tolerance / 10;
	const startSaturated = isSaturated(startB);
	let lower = startB;
	let upper = startB;
	let step = BRACKET_STEP_DB;

	for (let stepIndex = 0; stepIndex < MAX_BRACKET_STEPS; stepIndex++) {
		if (startSaturated) {
			lower = upper - step;

			if (!isSaturated(lower)) {
				break;
			}

			upper = lower;
		} else {
			upper = lower + step;

			if (isSaturated(upper)) {
				break;
			}

			lower = upper;
		}

		step *= 2;
	}

	while (upper - lower > CHECK_GRAIN_DB) {
		const mid = 0.5 * (lower + upper);

		if (isSaturated(mid)) {
			upper = mid;
		} else {
			lower = mid;
		}
	}

	return upper;
};

export const measuredCapOf = (attempts: ReadonlyArray<IterationAttempt>): number => {
	let cap = Number.POSITIVE_INFINITY;

	for (const lower of attempts) {
		if (
			lower.boost < cap &&
			attempts.some((higher) => higher.boost > lower.boost && levelOf(higher.outputLufs) < levelOf(lower.outputLufs))
		) {
			cap = lower.boost;
		}
	}

	return cap;
};

export const searchCapOf = (args: {
	predict: (B: number) => number;
	anchorsAt: (B: number) => Anchors;
	histogram: DetectionHistogram;
	attempts: ReadonlyArray<IterationAttempt>;
	targetLufs: number;
	startB: number;
	tolerance: number;
}): SearchCap => {
	const { predict, anchorsAt, histogram, attempts, targetLufs, startB, tolerance } = args;
	const bodyBound = bodySaturationBoost({ anchorsAt, histogram, startB, tolerance });
	const measuredCap = measuredCapOf(attempts);
	const bound: SearchCap =
		measuredCap <= bodyBound
			? { boost: measuredCap, cause: "stops-rising" }
			: { boost: bodyBound, cause: "body-limit" };
	const plateau = bracketBoost({ predict, targetLufs, startB, maxB: bound.boost, tolerance });

	return plateau.kind === "capped" && plateau.boost < bound.boost
		? { boost: plateau.boost, cause: "stops-rising" }
		: bound;
};

export const stopsRisingAt = (args: {
	attempts: ReadonlyArray<IterationAttempt>;
	cap: number;
	targetLufs: number;
	ceilingDb: number;
	tolerance: number;
}): boolean => {
	const { attempts, cap, targetLufs, ceilingDb, tolerance } = args;

	return attempts.some(
		(attempt) =>
			attempt.boost >= cap - CHECK_GRAIN_DB &&
			isLegalAttempt(attempt.outputLufs, attempt.outputTruePeakDb, targetLufs, ceilingDb) &&
			grainedDb(levelOf(attempt.outputLufs) - targetLufs) <= -tolerance,
	);
};

export const unreachableCauseOf = (
	stopCause: UnreachableCause,
	attempts: ReadonlyArray<IterationAttempt>,
): UnreachableCause =>
	stopCause === "stops-rising" ||
	attempts.some((lower) =>
		attempts.some(
			(higher) =>
				higher.boost > lower.boost &&
				(levelOf(higher.outputLufs) - levelOf(lower.outputLufs)) / (higher.boost - lower.boost) <
					MIN_OVERSHOOT_SLOPE,
		),
	)
		? "stops-rising"
		: "body-limit";

export const repeatsAttempt = (
	attempts: ReadonlyArray<IterationAttempt>,
	boost: number,
	effectiveCeilingDb: number,
): boolean =>
	attempts.some(
		(attempt) =>
			Math.abs(attempt.boost - boost) < REPEAT_GRAIN_DB &&
			Math.abs(attempt.ceilingDb - effectiveCeilingDb) < REPEAT_GRAIN_DB,
	);

export const overshootBoost = (attempts: ReadonlyArray<IterationAttempt>, targetLufs: number): number | null => {
	if (attempts.length < 2 || attempts.some((attempt) => grainedDb(levelOf(attempt.outputLufs) - targetLufs) <= 0)) {
		return null;
	}

	const [lowest, nextLowest] = [...attempts].sort((left, right) => left.boost - right.boost);

	if (lowest === undefined || nextLowest === undefined) {
		return null;
	}

	const slope = (levelOf(nextLowest.outputLufs) - levelOf(lowest.outputLufs)) / (nextLowest.boost - lowest.boost);

	return Number.isFinite(slope) && slope >= MIN_OVERSHOOT_SLOPE
		? lowest.boost - (levelOf(lowest.outputLufs) - targetLufs) / slope
		: lowest.boost - OVERSHOOT_STEP_DB * 2 ** (attempts.length - 2);
};

const bisectRoot = (args: {
	lower: number;
	upper: number;
	errorAt: (candidate: number) => number;
	tolerance: number;
}): number => {
	const { errorAt, tolerance } = args;
	let { lower, upper } = args;
	let workingLowerError = errorAt(lower);
	let best = lower;
	let bestAbsError = Math.abs(workingLowerError);
	const subToleranceBracket = tolerance / 100;

	for (let iteration = 0; iteration < MAX_BISECT_ITERATIONS && upper - lower >= subToleranceBracket; iteration++) {
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
	}

	return best;
};

const searchBoost = (args: {
	predict: (B: number) => number;
	targetLufs: number;
	startB: number;
	maxB: number;
	tolerance: number;
}): number => {
	const bracket = bracketBoost(args);

	if (bracket.kind === "capped") {
		return bracket.boost;
	}

	if (bracket.lower === bracket.upper) {
		return bracket.lower;
	}

	return bisectRoot({
		lower: bracket.lower,
		upper: bracket.upper,
		errorAt: (candidateB) => args.predict(candidateB) - args.targetLufs,
		tolerance: args.tolerance,
	});
};

const grainedDb = (errorDb: number): number => Math.round(errorDb / CHECK_GRAIN_DB) * CHECK_GRAIN_DB;

const levelOf = (figure: number | null): number => figure ?? Number.NEGATIVE_INFINITY;

export const holdsTruePeak = (outputTruePeakDb: number | null, targetTp: number | undefined): boolean =>
	targetTp === undefined || grainedDb(levelOf(outputTruePeakDb) - targetTp) <= 0;

export const isLegalAttempt = (
	outputLufs: number | null,
	outputTruePeakDb: number | null,
	targetLufs: number | undefined,
	targetTp: number | undefined,
): boolean =>
	(targetLufs === undefined || grainedDb(levelOf(outputLufs) - targetLufs) <= 0) &&
	holdsTruePeak(outputTruePeakDb, targetTp);

type AttemptOutput = Pick<IterationAttempt, "outputLufs" | "outputTruePeakDb">;

const distanceOf = (value: number | null, target: number | undefined): number =>
	target === undefined ? 0 : Math.abs(levelOf(value) - target);

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

export const nextSearchBoost = (
	attempts: ReadonlyArray<IterationAttempt>,
	residualBoost: number,
	targetLufs: number,
): number => {
	let highestUnderBoost: number | undefined;
	let lowestOverBoost: number | undefined;

	for (const attempt of attempts) {
		if (levelOf(attempt.outputLufs) <= targetLufs) {
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

export const hasConverged = (
	attempt: IterationAttempt | undefined,
	targetLufs: number | undefined,
	targetTp: number | undefined,
	tolerance: number,
): boolean => {
	if (attempt === undefined) {
		return false;
	}

	const landingError = targetLufs === undefined ? attempt.peakErr : attempt.lufsErr;

	return (
		landingError !== null &&
		isLegalAttempt(attempt.outputLufs, attempt.outputTruePeakDb, targetLufs, targetTp) &&
		Math.abs(grainedDb(landingError)) < tolerance
	);
};

const nextCeilingDb = (ceilingDb: number, effectiveCeilingDb: number, outputTruePeakDb: number): number =>
	Math.min(ceilingDb, effectiveCeilingDb - (outputTruePeakDb - ceilingDb));

type MeasuredOutput = Pick<IterationAttempt, "outputLufs" | "outputLra" | "outputTruePeakDb"> & {
	readonly residualLufs: number;
	readonly residualTruePeakDb: number;
};

const measureAttemptOutput = async (args: {
	inputPath: string;
	sampleRate: number;
	channelCount: number;
	weights: Float64Array;
	quantize: (sample: number) => number;
	envelope: SampleFile;
	oversampling: OversamplingFactor;
}): Promise<MeasuredOutput> => {
	const { inputPath, sampleRate, channelCount, weights, quantize, envelope, oversampling } = args;
	const lufsAccumulator = new IntegratedLufsAccumulator(sampleRate, weights);
	const shortTermAccumulator = new ShortTermLoudnessAccumulator(sampleRate, weights);
	const truePeakAccumulator = new TruePeakAccumulator(channelCount, oversampling);

	await forEachEnvelopedBlock(inputPath, envelope, quantize, (channels, frameCount) => {
		lufsAccumulator.push(channels, frameCount);
		shortTermAccumulator.push(channels, frameCount);
		truePeakAccumulator.push(channels, frameCount);
	});

	const lufs = lufsAccumulator.finalize();
	const truePeak = truePeakAccumulator.finalize();

	return {
		outputLufs: lufsOrNull(lufs),
		outputLra: computeLoudnessRange(shortTermAccumulator.finalize()),
		outputTruePeakDb: peakDbOrNull(truePeak),
		residualLufs: lufs,
		residualTruePeakDb: linearToDb(truePeak),
	};
};

export const iterateForTargets = async (
	args: {
		inputPath: string;
		scratch: Scratch;
		sampleRate: number;
		channelCount: number;
		weights: Float64Array;
		frameCount: number;
		outputBitDepth: SourceBitDepth;
		anchorBase: AnchorBase;
		smoothingMs: number;
		sourceLufs: number;
		maxAttempts?: number;
		tolerance?: number;
		neverExpand: boolean;
		oversampling?: OversamplingFactor;
		histogram: DetectionHistogram;
		loudnessEnvelope: SampleFile;
		peakEnvelope: SampleFile;
		onAttempt?: (attempt: IterationAttempt, attemptIndex: number) => void;
	} & Targets,
): Promise<IterateResult> => {
	const {
		inputPath,
		scratch,
		sampleRate,
		channelCount,
		weights,
		frameCount,
		outputBitDepth,
		anchorBase,
		smoothingMs,
		targetLufs,
		targetTp,
		sourceLufs,
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		tolerance = DEFAULT_TOLERANCE,
		neverExpand,
		oversampling = DEFAULT_OVERSAMPLING,
		histogram,
		loudnessEnvelope,
		peakEnvelope,
		onAttempt,
	} = args;
	const closeEnvelopes = async (): Promise<void> => {
		try {
			await loudnessEnvelope.close();
		} finally {
			await peakEnvelope.close();
		}
	};

	if (channelCount === 0 || frameCount === 0) {
		await closeEnvelopes();

		return {
			bestSmoothedEnvelope: await SampleFile.create(scratch, "empty-envelope"),
			bestB: 0,
			bestPeakGainDb: null,
			attempts: [],
			converged: false,
			unreachableLufs: null,
			unreachableCause: null,
			winnerOutputLufs: null,
			winnerOutputTruePeakDb: null,
			winnerOutputLra: null,
		};
	}

	const { limitDb } = anchorBase;
	const ceilingDb = targetTp ?? DEFAULT_CEILING_DB;
	const isArmOn = anchorBase.kneeDb !== null;
	const startBoost = targetLufs === undefined ? ceilingDb - limitDb : targetLufs - sourceLufs;
	const expansionDb = neverExpand ? 0 : Math.max(0, ceilingDb - limitDb - startBoost);
	const holdHalfWidth = holdHalfWidthOf(windowSamplesFromMs(smoothingMs, sampleRate));
	const quantize = quantizerOf(outputBitDepth);
	const attempts: Array<IterationAttempt> = [];
	let effectiveCeilingDb = ceilingDb;
	let residual = 0;
	const anchorsAt = (boost: number): Anchors => ({
		...anchorBase,
		ceilingDb: effectiveCeilingDb,
		B: boost,
		peakGainDb: isArmOn ? peakGainDbOf({ boost, ceilingDb: effectiveCeilingDb, limitDb, expansionDb }) : boost,
	});
	const predictWithResidual = (boost: number): number =>
		predictOutputLufs(sourceLufs, anchorsAt(boost), histogram) + residual;
	const capOf = (lufsTarget: number | undefined): SearchCap =>
		lufsTarget === undefined
			? { boost: Number.POSITIVE_INFINITY, cause: "body-limit" }
			: searchCapOf({
					predict: predictWithResidual,
					anchorsAt,
					histogram,
					attempts,
					targetLufs: lufsTarget,
					startB: startBoost,
					tolerance,
				});
	const stopsRising = (cap: number): boolean =>
		targetLufs !== undefined && stopsRisingAt({ attempts, cap, targetLufs, ceilingDb, tolerance });
	const nextBoost = (cap: number): number => {
		if (targetLufs === undefined) {
			return effectiveCeilingDb - limitDb;
		}

		const underOvershoot = overshootBoost(attempts, targetLufs);

		if (underOvershoot !== null) {
			return Math.min(cap, underOvershoot);
		}

		const root = searchBoost({
			predict: predictWithResidual,
			targetLufs,
			startB: startBoost,
			maxB: cap,
			tolerance,
		});

		return Math.min(
			cap,
			nextSearchBoost(
				attempts.filter((attempt) => attempt.boost <= cap),
				root,
				targetLufs,
			),
		);
	};
	let winningAttempt: IterationAttempt | undefined;
	let winningEnvelope: SampleFile | undefined;
	let stopCap: SearchCap | undefined;

	try {
		for (
			let attemptIndex = 0;
			attemptIndex < maxAttempts ||
			(attemptIndex < LEGALITY_ATTEMPT_LIMIT &&
				!attempts.some((attempt) =>
					isLegalAttempt(attempt.outputLufs, attempt.outputTruePeakDb, targetLufs, ceilingDb),
				));
			attemptIndex++
		) {
			const cap = capOf(targetLufs);

			if (stopsRising(cap.boost)) {
				stopCap = cap;

				break;
			}

			const boost = nextBoost(cap.boost);

			if (repeatsAttempt(attempts, boost, effectiveCeilingDb)) {
				break;
			}

			const anchors = anchorsAt(boost);
			const dest = await SampleFile.create(scratch, `envelope-${attemptIndex}`);
			let measured: MeasuredOutput;

			try {
				await renderEnvelope({ loudnessEnvelope, peakEnvelope, dest, anchors, holdHalfWidth });
				measured = await measureAttemptOutput({
					inputPath,
					sampleRate,
					channelCount,
					weights,
					quantize,
					envelope: dest,
					oversampling,
				});
			} catch (error: unknown) {
				await dest.close();

				throw error;
			}

			const attempt: IterationAttempt = {
				boost,
				peakGainDb: isArmOn ? anchors.peakGainDb : null,
				ceilingDb: effectiveCeilingDb,
				lufsErr: targetLufs === undefined || measured.outputLufs === null ? null : measured.outputLufs - targetLufs,
				peakErr:
					targetTp === undefined || measured.outputTruePeakDb === null
						? null
						: measured.outputTruePeakDb - targetTp,
				outputLufs: measured.outputLufs,
				outputTruePeakDb: measured.outputTruePeakDb,
				outputLra: measured.outputLra,
			};

			attempts.push(attempt);
			onAttempt?.(attempt, attemptIndex);

			if (attemptBeatsWinner(attempt, winningAttempt, targetLufs, ceilingDb)) {
				winningAttempt = attempt;

				const previousWinner = winningEnvelope;

				winningEnvelope = dest;

				if (previousWinner !== undefined) {
					await previousWinner.close();
				}
			} else {
				await dest.close();
			}

			if (targetLufs !== undefined) {
				const measuredResidual = measured.residualLufs - predictOutputLufs(sourceLufs, anchors, histogram);

				residual = Number.isFinite(measuredResidual) ? measuredResidual : 0;
			}

			effectiveCeilingDb = nextCeilingDb(ceilingDb, effectiveCeilingDb, measured.residualTruePeakDb);

			if (hasConverged(winningAttempt, targetLufs, ceilingDb, tolerance)) {
				break;
			}
		}

		const converged = hasConverged(winningAttempt, targetLufs, ceilingDb, tolerance);

		if (!converged && stopCap === undefined) {
			const cap = capOf(targetLufs);

			stopCap = stopsRising(cap.boost) ? cap : undefined;
		}

		const unreachable = converged ? undefined : stopCap;

		const result: IterateResult = {
			bestSmoothedEnvelope: winningEnvelope ?? (await SampleFile.create(scratch, "empty-envelope")),
			bestB: winningAttempt?.boost ?? 0,
			bestPeakGainDb: winningAttempt?.peakGainDb ?? null,
			attempts,
			converged,
			unreachableLufs: unreachable === undefined ? null : (winningAttempt?.outputLufs ?? null),
			unreachableCause: unreachable === undefined ? null : unreachableCauseOf(unreachable.cause, attempts),
			winnerOutputLufs: winningAttempt?.outputLufs ?? null,
			winnerOutputTruePeakDb: winningAttempt?.outputTruePeakDb ?? null,
			winnerOutputLra: winningAttempt?.outputLra ?? null,
		};

		winningEnvelope = undefined;

		return result;
	} finally {
		try {
			await winningEnvelope?.close();
		} finally {
			await closeEnvelopes();
		}
	}
};
