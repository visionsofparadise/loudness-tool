import { IntegratedLufsAccumulator } from "../../../measurement/IntegratedLufsAccumulator";
import { computeLoudnessRange } from "../../../measurement/loudnessRange";
import { ShortTermLoudnessAccumulator } from "../../../measurement/ShortTermLoudnessAccumulator";
import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { linearToDb, lufsOrNull, peakDbOrNull } from "../../../utils/db";
import { SampleFile } from "../../../utils/SampleFile";
import { quantizerOf } from "../../../wav/utils/sampleCodec";
import { forEachEnvelopedBlock } from "./apply";
import { gainDbAt } from "./curve";
import { renderEnvelope } from "./envelope";
import { CELL_COUNT, cellCentreDb } from "./measureSource";
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
	winnerOutputLufs: number | null;
	winnerOutputTruePeakDb: number | null;
	winnerOutputLra: number | null;
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
	tolerance: number;
}):
	| { readonly kind: "bracket"; readonly lower: number; readonly upper: number }
	| { readonly kind: "unreachable"; readonly loudestLufs: number; readonly boost: number } => {
	const { predict, targetLufs, startB, tolerance } = args;
	const startLufs = predict(startB);

	if (startLufs === targetLufs) {
		return { kind: "bracket", lower: startB, upper: startB };
	}

	const direction = startLufs < targetLufs ? 1 : -1;
	let previousB = startB;
	let previousLufs = startLufs;
	let step = BRACKET_STEP_DB;

	for (let stepIndex = 0; stepIndex < MAX_BRACKET_STEPS; stepIndex++) {
		const candidateB = previousB + direction * step;
		const candidateLufs = predict(candidateB);

		if (direction > 0 ? candidateLufs >= targetLufs : candidateLufs <= targetLufs) {
			return {
				kind: "bracket",
				lower: Math.min(previousB, candidateB),
				upper: Math.max(previousB, candidateB),
			};
		}

		if (direction > 0 && !(candidateLufs - previousLufs >= tolerance / 10)) {
			return { kind: "unreachable", loudestLufs: Math.max(candidateLufs, previousLufs), boost: candidateB };
		}

		previousB = candidateB;
		previousLufs = candidateLufs;
		step *= 2;
	}

	return { kind: "unreachable", loudestLufs: previousLufs, boost: previousB };
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
	tolerance: number;
}): { readonly boost: number; readonly unreachableLufs: number | null } => {
	const bracket = bracketBoost(args);

	if (bracket.kind === "unreachable") {
		return { boost: bracket.boost, unreachableLufs: bracket.loudestLufs };
	}

	if (bracket.lower === bracket.upper) {
		return { boost: bracket.lower, unreachableLufs: null };
	}

	return {
		boost: bisectRoot({
			lower: bracket.lower,
			upper: bracket.upper,
			errorAt: (candidateB) => args.predict(candidateB) - args.targetLufs,
			tolerance: args.tolerance,
		}),
		unreachableLufs: null,
	};
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
}): Promise<MeasuredOutput> => {
	const { inputPath, sampleRate, channelCount, weights, quantize, envelope } = args;
	const lufsAccumulator = new IntegratedLufsAccumulator(sampleRate, weights);
	const shortTermAccumulator = new ShortTermLoudnessAccumulator(sampleRate, weights);
	const truePeakAccumulator = new TruePeakAccumulator(channelCount);

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
	const nextBoost = (): { readonly boost: number; readonly unreachableLufs: number | null } => {
		if (targetLufs === undefined) {
			return { boost: effectiveCeilingDb - limitDb, unreachableLufs: null };
		}

		const found = searchBoost({
			predict: (boost) => predictOutputLufs(sourceLufs, anchorsAt(boost), histogram) + residual,
			targetLufs,
			startB: startBoost,
			tolerance,
		});

		return found.unreachableLufs === null
			? { boost: nextSearchBoost(attempts, found.boost, targetLufs), unreachableLufs: null }
			: found;
	};
	let winningAttempt: IterationAttempt | undefined;
	let winningEnvelope: SampleFile | undefined;
	let unreachableLufs: number | null = null;

	try {
		for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
			const next = nextBoost();
			const anchors = anchorsAt(next.boost);
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
				});
			} catch (error: unknown) {
				await dest.close();

				throw error;
			}

			const attempt: IterationAttempt = {
				boost: next.boost,
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

			unreachableLufs = next.unreachableLufs;

			if (
				hasConverged(winningAttempt, targetLufs, ceilingDb, tolerance) ||
				(unreachableLufs !== null &&
					isLegalAttempt(attempt.outputLufs, attempt.outputTruePeakDb, targetLufs, ceilingDb))
			) {
				break;
			}
		}

		const converged = hasConverged(winningAttempt, targetLufs, ceilingDb, tolerance);
		const result: IterateResult = {
			bestSmoothedEnvelope: winningEnvelope ?? (await SampleFile.create(scratch, "empty-envelope")),
			bestB: winningAttempt?.boost ?? 0,
			bestPeakGainDb: winningAttempt?.peakGainDb ?? null,
			attempts,
			converged,
			unreachableLufs:
				converged || unreachableLufs === null ? null : (winningAttempt?.outputLufs ?? unreachableLufs),
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
