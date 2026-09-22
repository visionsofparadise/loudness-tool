type Direction = 1 | -1;

abstract class SlidingWindowStream {
	protected readonly halfWidth: number;
	protected consumedFrames = 0;
	private emittedFrames = 0;

	constructor(halfWidth: number, callerName: string) {
		if (halfWidth < 0 || !Number.isFinite(halfWidth)) {
			throw new RangeError(`${callerName}: halfWidth must be a non-negative finite number, got ${halfWidth}`);
		}

		this.halfWidth = halfWidth;
	}

	push(chunk: Float64Array, isFinal: boolean): Float64Array {
		const chunkLength = chunk.length;
		const halfWidth = this.halfWidth;
		const totalAfter = this.consumedFrames + chunkLength;
		const targetEmittedAfter = isFinal ? totalAfter : Math.max(0, totalAfter - halfWidth);
		const emitCount = Math.max(0, targetEmittedAfter - this.emittedFrames);
		const output = new Float64Array(emitCount);
		let outputCursor = 0;

		for (let chunkIndex = 0; chunkIndex < chunkLength; chunkIndex++) {
			const inputIndex = this.consumedFrames;

			this.ingest(chunk[chunkIndex] ?? 0, inputIndex);
			this.consumedFrames++;

			const outputIndex = inputIndex - halfWidth;

			if (outputIndex < 0) {
				continue;
			}

			output[outputCursor] = this.emitAt(outputIndex);
			outputCursor++;
			this.emittedFrames++;
		}

		if (isFinal) {
			const finalLength = this.consumedFrames;

			while (this.emittedFrames < finalLength) {
				output[outputCursor] = this.emitAt(this.emittedFrames);
				outputCursor++;
				this.emittedFrames++;
			}
		}

		return output;
	}

	protected abstract ingest(value: number, inputIndex: number): void;

	protected abstract emitAt(outputIndex: number): number;
}

// eslint-disable-next-line comment-rules/no-restricted-comments
// Monotonic deque per Lemire, "Streaming Maximum-Minimum Filter Using No More than Three Comparisons per Element" (2006).
class SlidingWindowExtremeStream extends SlidingWindowStream {
	private readonly direction: Direction;
	private readonly lookAhead: Float64Array;
	private readonly deque: Int32Array;
	private dequeHead = 0;
	private dequeTail = 0;

	constructor(halfWidth: number, direction: Direction, callerName: string) {
		super(halfWidth, callerName);

		this.direction = direction;

		const ringCapacity = 2 * halfWidth + 1;

		this.lookAhead = new Float64Array(ringCapacity);
		this.deque = new Int32Array(ringCapacity + 1);
	}

	protected ingest(value: number, inputIndex: number): void {
		const ringSize = this.lookAhead.length;
		const dequeCapacity = this.deque.length;
		const orderedValue = value * this.direction;

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
	}

	protected emitAt(outputIndex: number): number {
		const ringSize = this.lookAhead.length;
		const dequeCapacity = this.deque.length;
		const leftEdge = Math.max(0, outputIndex - this.halfWidth);

		while (this.dequeTail > this.dequeHead && (this.deque[this.dequeHead % dequeCapacity] ?? 0) < leftEdge) {
			this.dequeHead++;
		}

		if (this.dequeTail === this.dequeHead) {
			return 0;
		}

		const frontIndex = this.deque[this.dequeHead % dequeCapacity] ?? 0;

		return (this.lookAhead[frontIndex % ringSize] ?? 0) * this.direction;
	}
}

export class SlidingWindowMaxStream extends SlidingWindowExtremeStream {
	constructor(halfWidth: number) {
		super(halfWidth, 1, "SlidingWindowMaxStream");
	}
}

export class SlidingWindowMinStream extends SlidingWindowExtremeStream {
	constructor(halfWidth: number) {
		super(halfWidth, -1, "SlidingWindowMinStream");
	}
}

export class SlidingWindowMeanStream extends SlidingWindowStream {
	private readonly ring: Float64Array;
	private sum = 0;
	private windowStart = 0;

	constructor(halfWidth: number) {
		super(halfWidth, "SlidingWindowMeanStream");

		this.ring = new Float64Array(2 * halfWidth + 2);
	}

	protected ingest(value: number, inputIndex: number): void {
		this.ring[inputIndex % this.ring.length] = value;
		this.sum += value;
	}

	protected emitAt(outputIndex: number): number {
		const ringSize = this.ring.length;
		const nextStart = Math.max(0, outputIndex - this.halfWidth);

		while (this.windowStart < nextStart) {
			this.sum -= this.ring[this.windowStart % ringSize] ?? 0;
			this.windowStart++;
		}

		return this.sum / (this.consumedFrames - this.windowStart);
	}
}
