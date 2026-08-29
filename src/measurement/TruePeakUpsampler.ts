// eslint-disable-next-line comment-rules/no-restricted-comments
// Four-phase, 12-tap FIR coefficient columns from ITU-R BS.1770-5 Annex 2.

const OVERSAMPLE_FACTOR = 4;
const TAPS_PER_PHASE = 12;
const HISTORY_LENGTH = TAPS_PER_PHASE;
const FLUSH_INPUT = new Float64Array(TAPS_PER_PHASE - 1);

const P0T0 = 0.001708984375;
const P0T1 = 0.010986328125;
const P0T2 = -0.0196533203125;
const P0T3 = 0.033203125;
const P0T4 = -0.0594482421875;
const P0T5 = 0.1373291015625;
const P0T6 = 0.97216796875;
const P0T7 = -0.102294921875;
const P0T8 = 0.047607421875;
const P0T9 = -0.026611328125;
const P0T10 = 0.014892578125;
const P0T11 = -0.00830078125;

const P1T0 = -0.0291748046875;
const P1T1 = 0.029296875;
const P1T2 = -0.0517578125;
const P1T3 = 0.089111328125;
const P1T4 = -0.16650390625;
const P1T5 = 0.465087890625;
const P1T6 = 0.77978515625;
const P1T7 = -0.2003173828125;
const P1T8 = 0.1015625;
const P1T9 = -0.0582275390625;
const P1T10 = 0.0330810546875;
const P1T11 = -0.0189208984375;

const P2T0 = -0.0189208984375;
const P2T1 = 0.0330810546875;
const P2T2 = -0.0582275390625;
const P2T3 = 0.1015625;
const P2T4 = -0.2003173828125;
const P2T5 = 0.77978515625;
const P2T6 = 0.465087890625;
const P2T7 = -0.16650390625;
const P2T8 = 0.089111328125;
const P2T9 = -0.0517578125;
const P2T10 = 0.029296875;
const P2T11 = -0.0291748046875;

const P3T0 = -0.00830078125;
const P3T1 = 0.014892578125;
const P3T2 = -0.026611328125;
const P3T3 = 0.047607421875;
const P3T4 = -0.102294921875;
const P3T5 = 0.97216796875;
const P3T6 = 0.1373291015625;
const P3T7 = -0.0594482421875;
const P3T8 = 0.033203125;
const P3T9 = -0.0196533203125;
const P3T10 = 0.010986328125;
const P3T11 = 0.001708984375;

export class TruePeakUpsampler {
	private readonly history = new Float64Array(HISTORY_LENGTH);
	private work: Float64Array = new Float64Array(0);
	private flushed = false;

	upsample(input: Float64Array, frameCount: number, output: Float64Array): number {
		if (this.flushed) {
			throw new Error("TruePeakUpsampler: upsample after flush; call reset() first");
		}

		if (frameCount < 0) {
			throw new Error(`TruePeakUpsampler: frameCount must be non-negative, got ${frameCount}`);
		}

		if (input.length < frameCount) {
			throw new Error(
				`TruePeakUpsampler: input has ${input.length} samples, fewer than the requested ${frameCount}`,
			);
		}

		return this.process(input, frameCount, output);
	}

	flush(output: Float64Array): number {
		if (this.flushed) {
			return 0;
		}

		const written = this.process(FLUSH_INPUT, FLUSH_INPUT.length, output);

		this.flushed = true;

		return written;
	}

	reset(): void {
		this.history.fill(0);
		this.work = new Float64Array(0);
		this.flushed = false;
	}

	private process(input: Float64Array, frameCount: number, output: Float64Array): number {
		const outputLength = frameCount * OVERSAMPLE_FACTOR;

		if (output.length < outputLength) {
			throw new Error(
				`TruePeakUpsampler: output length ${output.length} is below the ${outputLength} samples required`,
			);
		}

		const history = this.history;
		const workLength = HISTORY_LENGTH + frameCount;

		if (this.work.length < workLength) {
			this.work = new Float64Array(workLength);
		}

		const work = this.work;

		work.set(history, 0);

		for (let inputIndex = 0; inputIndex < frameCount; inputIndex++) {
			work[HISTORY_LENGTH + inputIndex] = input[inputIndex] ?? 0;
		}

		for (let inputIndex = 0; inputIndex < frameCount; inputIndex++) {
			const currentIndex = HISTORY_LENGTH + inputIndex;
			const outputOffset = inputIndex * OVERSAMPLE_FACTOR;
			const value0 = work[currentIndex] ?? 0;
			const value1 = work[currentIndex - 1] ?? 0;
			const value2 = work[currentIndex - 2] ?? 0;
			const value3 = work[currentIndex - 3] ?? 0;
			const value4 = work[currentIndex - 4] ?? 0;
			const value5 = work[currentIndex - 5] ?? 0;
			const value6 = work[currentIndex - 6] ?? 0;
			const value7 = work[currentIndex - 7] ?? 0;
			const value8 = work[currentIndex - 8] ?? 0;
			const value9 = work[currentIndex - 9] ?? 0;
			const value10 = work[currentIndex - 10] ?? 0;
			const value11 = work[currentIndex - 11] ?? 0;
			let phase0 = 0;

			phase0 += P0T0 * value0;
			phase0 += P0T1 * value1;
			phase0 += P0T2 * value2;
			phase0 += P0T3 * value3;
			phase0 += P0T4 * value4;
			phase0 += P0T5 * value5;
			phase0 += P0T6 * value6;
			phase0 += P0T7 * value7;
			phase0 += P0T8 * value8;
			phase0 += P0T9 * value9;
			phase0 += P0T10 * value10;
			phase0 += P0T11 * value11;

			let phase1 = 0;

			phase1 += P1T0 * value0;
			phase1 += P1T1 * value1;
			phase1 += P1T2 * value2;
			phase1 += P1T3 * value3;
			phase1 += P1T4 * value4;
			phase1 += P1T5 * value5;
			phase1 += P1T6 * value6;
			phase1 += P1T7 * value7;
			phase1 += P1T8 * value8;
			phase1 += P1T9 * value9;
			phase1 += P1T10 * value10;
			phase1 += P1T11 * value11;

			let phase2 = 0;

			phase2 += P2T0 * value0;
			phase2 += P2T1 * value1;
			phase2 += P2T2 * value2;
			phase2 += P2T3 * value3;
			phase2 += P2T4 * value4;
			phase2 += P2T5 * value5;
			phase2 += P2T6 * value6;
			phase2 += P2T7 * value7;
			phase2 += P2T8 * value8;
			phase2 += P2T9 * value9;
			phase2 += P2T10 * value10;
			phase2 += P2T11 * value11;

			let phase3 = 0;

			phase3 += P3T0 * value0;
			phase3 += P3T1 * value1;
			phase3 += P3T2 * value2;
			phase3 += P3T3 * value3;
			phase3 += P3T4 * value4;
			phase3 += P3T5 * value5;
			phase3 += P3T6 * value6;
			phase3 += P3T7 * value7;
			phase3 += P3T8 * value8;
			phase3 += P3T9 * value9;
			phase3 += P3T10 * value10;
			phase3 += P3T11 * value11;

			output[outputOffset] = phase0;
			output[outputOffset + 1] = phase1;
			output[outputOffset + 2] = phase2;
			output[outputOffset + 3] = phase3;
		}

		if (frameCount >= HISTORY_LENGTH) {
			history.set(work.subarray(workLength - HISTORY_LENGTH, workLength), 0);
		} else if (frameCount > 0) {
			history.copyWithin(0, frameCount);
			history.set(work.subarray(HISTORY_LENGTH, workLength), HISTORY_LENGTH - frameCount);
		}

		return outputLength;
	}
}
