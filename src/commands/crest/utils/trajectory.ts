import { BidirectionalIir } from "../../../measurement/BidirectionalIir";
import { GROUP_DELAY_CEILING_MS } from "./search";

export interface ControlTrajectory {
	readonly rows: ReadonlyArray<Float64Array>;
	readonly baseRows: ReadonlyArray<Float64Array>;
	readonly amountEnv: Float64Array;
	readonly laneCount: number;
	readonly identity: Float64Array;
	readonly transientMask: Float64Array;
	readonly peakSampleIndex: Int32Array;
}

const TRANSIENT_PULLBACK = 0.5;

export const trajectoryFrameRate = (sampleRate: number, hopSize: number): number => {
	if (!(sampleRate > 0) || !(hopSize > 0)) {
		return 1;
	}

	const rate = sampleRate / hopSize;

	return rate > 0 && Number.isFinite(rate) ? rate : 1;
};

export const exactHoldHalfWidthFrames = (sampleRate: number, hopSize: number): number => {
	if (!(sampleRate > 0) || !(hopSize > 0)) {
		return 1;
	}

	const ceilingSamples = (GROUP_DELAY_CEILING_MS / 1000) * sampleRate;

	return Math.max(1, Math.ceil(ceilingSamples / hopSize) + 1);
};

export const smoothControlTrajectory = (
	trajectory: ControlTrajectory,
	smoothingMs: number,
	frameRate: number,
	exactHoldFrames: number,
	hopSize: number,
): ControlTrajectory => {
	const baseRows = trajectory.baseRows;
	const amountEnv = trajectory.amountEnv;
	const peakSampleIndex = trajectory.peakSampleIndex;
	const frameCount = baseRows.length;
	const laneCount = trajectory.laneCount;

	if (frameCount === 0 || laneCount === 0) {
		return {
			rows: [],
			baseRows,
			amountEnv,
			laneCount,
			identity: trajectory.identity,
			transientMask: trajectory.transientMask,
			peakSampleIndex,
		};
	}

	const transientMask = trajectory.transientMask;
	const identity = trajectory.identity;
	const halfWidth = Math.max(1, Math.floor(exactHoldFrames));
	const hop = hopSize > 0 ? hopSize : 1;
	const exactHeld = new Float64Array(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		const amount = amountEnv[frame] ?? 0;

		if (amount <= 0) {
			continue;
		}

		const peakSample = peakSampleIndex[frame] ?? frame * hop;
		const center = Math.round(peakSample / hop);
		const lo = Math.max(0, center - halfWidth);
		const hi = Math.min(frameCount - 1, center + halfWidth);

		for (let held = lo; held <= hi; held++) {
			if (amount > (exactHeld[held] ?? 0)) {
				exactHeld[held] = amount;
			}
		}
	}

	const pulled = new Float64Array(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		const value = amountEnv[frame] ?? 0;
		const isTransient = (transientMask[frame] ?? 0) > 0;

		pulled[frame] = isTransient ? value + TRANSIENT_PULLBACK * (0 - value) : value;
	}

	const iir = new BidirectionalIir(smoothingMs, frameRate);

	iir.applyBidirectional(pulled);

	const finalAmount = new Float64Array(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		finalAmount[frame] = Math.max(exactHeld[frame] ?? 0, pulled[frame] ?? 0);
	}

	const rows: Array<Float64Array> = new Array<Float64Array>(frameCount);

	for (let frame = 0; frame < frameCount; frame++) {
		const base = baseRows[frame] ?? identity;
		const amount = finalAmount[frame] ?? 0;
		const row = new Float64Array(laneCount);

		for (let lane = 0; lane < laneCount; lane++) {
			row[lane] = amount * (base[lane] ?? 0);
		}

		rows[frame] = row;
	}

	return { rows, baseRows, amountEnv, laneCount, identity, transientMask, peakSampleIndex };
};
