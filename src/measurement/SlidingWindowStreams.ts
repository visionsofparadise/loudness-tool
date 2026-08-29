type Direction = 1 | -1;

// eslint-disable-next-line comment-rules/no-restricted-comments
// Monotonic deque per Lemire, "Streaming Maximum-Minimum Filter Using No More than Three Comparisons per Element" (2006).
class SlidingWindowExtremeStream {
	private readonly halfWidth: number;
	private readonly direction: Direction;
	private readonly lookAhead: Float64Array;
	private readonly deque: Int32Array;
	private dequeHead = 0;
	private dequeTail = 0;
	private consumedFrames = 0;
	private emittedFrames = 0;

	constructor(halfWidth: number, direction: Direction, callerName: string) {
		if (halfWidth < 0 || !Number.isFinite(halfWidth)) {
			throw new RangeError(`${callerName}: halfWidth must be a non-negative finite number, got ${halfWidth}`);
		}

		this.halfWidth = halfWidth;
		this.direction = direction;

		const ringCapacity = 2 * halfWidth + 1;

		this.lookAhead = new Float64Array(ringCapacity);
		this.deque = new Int32Array(ringCapacity);
	}

	push(chunk: Float64Array, isFinal: boolean): Float64Array {
		const chunkLength = chunk.length;
		const halfWidth = this.halfWidth;
		const direction = this.direction;
		const ringSize = this.lookAhead.length;
		const dequeCapacity = this.deque.length;
		const totalAfter = this.consumedFrames + chunkLength;
		const targetEmittedAfter = isFinal ? totalAfter : Math.max(0, totalAfter - halfWidth);
		const emitCount = Math.max(0, targetEmittedAfter - this.emittedFrames);
		const output = new Float64Array(emitCount);
		let outputCursor = 0;

		for (let chunkIndex = 0; chunkIndex < chunkLength; chunkIndex++) {
			const inputIndex = this.consumedFrames;
			const orderedValue = (chunk[chunkIndex] ?? 0) * direction;

			this.lookAhead[inputIndex % ringSize] = orderedValue;

			while (this.dequeTail > this.dequeHead) {
				const tailIndex = this.deque[(this.dequeTail - 1) % dequeCapacity] ?? 0;
				const tailValue = this.lookAhead[tailIndex % ringSize] ?? 0;

				if (tailValue > orderedValue) {
					break;
				}

				this.dequeTail--;
			}

			this.deque[this.dequeTail % dequeCapacity] = inputIndex;
			this.dequeTail++;
			this.consumedFrames++;

			const outputIndex = inputIndex - halfWidth;

			if (outputIndex < 0) {
				continue;
			}

			const leftEdge = Math.max(0, outputIndex - halfWidth);

			while (this.dequeTail > this.dequeHead && (this.deque[this.dequeHead % dequeCapacity] ?? 0) < leftEdge) {
				this.dequeHead++;
			}

			const frontIndex = this.deque[this.dequeHead % dequeCapacity] ?? 0;

			output[outputCursor] = (this.lookAhead[frontIndex % ringSize] ?? 0) * direction;
			outputCursor++;
			this.emittedFrames++;
		}

		if (isFinal) {
			const finalLength = this.consumedFrames;

			while (this.emittedFrames < finalLength) {
				const outputIndex = this.emittedFrames;
				const leftEdge = Math.max(0, outputIndex - halfWidth);

				while (this.dequeTail > this.dequeHead && (this.deque[this.dequeHead % dequeCapacity] ?? 0) < leftEdge) {
					this.dequeHead++;
				}

				if (this.dequeTail === this.dequeHead) {
					output[outputCursor] = 0;
				} else {
					const frontIndex = this.deque[this.dequeHead % dequeCapacity] ?? 0;

					output[outputCursor] = (this.lookAhead[frontIndex % ringSize] ?? 0) * direction;
				}

				outputCursor++;
				this.emittedFrames++;
			}
		}

		return output;
	}
}

export class SlidingWindowMaxStream {
	private readonly window: SlidingWindowExtremeStream;

	constructor(halfWidth: number) {
		this.window = new SlidingWindowExtremeStream(halfWidth, 1, "SlidingWindowMaxStream");
	}

	push(chunk: Float64Array, isFinal: boolean): Float64Array {
		return this.window.push(chunk, isFinal);
	}
}

export class SlidingWindowMinStream {
	private readonly window: SlidingWindowExtremeStream;

	constructor(halfWidth: number) {
		this.window = new SlidingWindowExtremeStream(halfWidth, -1, "SlidingWindowMinStream");
	}

	push(chunk: Float64Array, isFinal: boolean): Float64Array {
		return this.window.push(chunk, isFinal);
	}
}
