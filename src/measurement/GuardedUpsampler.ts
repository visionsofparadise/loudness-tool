export abstract class GuardedUpsampler {
	private flushed = false;
	private readonly flushInput: Float64Array;

	protected constructor(
		private readonly name: string,
		readonly factor: number,
		flushFrames: number,
	) {
		this.flushInput = new Float64Array(flushFrames);
	}

	upsample(input: Float64Array, frameCount: number, output: Float64Array): number {
		if (this.flushed) {
			throw new Error(`${this.name}: upsample after flush; call reset() first`);
		}

		if (frameCount < 0) {
			throw new Error(`${this.name}: frameCount must be non-negative, got ${frameCount}`);
		}

		if (input.length < frameCount) {
			throw new Error(`${this.name}: input has ${input.length} samples, fewer than the requested ${frameCount}`);
		}

		return this.processChecked(input, frameCount, output);
	}

	flush(output: Float64Array): number {
		if (this.flushed) {
			return 0;
		}

		const written = this.processChecked(this.flushInput, this.flushInput.length, output);

		this.flushed = true;

		return written;
	}

	reset(): void {
		this.clear();
		this.flushed = false;
	}

	protected abstract process(input: Float64Array, frameCount: number, output: Float64Array): void;

	protected abstract clear(): void;

	private processChecked(input: Float64Array, frameCount: number, output: Float64Array): number {
		const outputLength = frameCount * this.factor;

		if (output.length < outputLength) {
			throw new Error(`${this.name}: output length ${output.length} is below the ${outputLength} samples required`);
		}

		this.process(input, frameCount, output);

		return outputLength;
	}
}
