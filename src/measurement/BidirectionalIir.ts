const bidirectionalAlphasOf = (
	sampleRate: number,
	smoothingMs: number,
): { readonly causal: number; readonly bidirectional: number } => {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new Error(`BidirectionalIir: sampleRate must be positive and finite, got ${sampleRate}`);
	}

	if (!Number.isFinite(smoothingMs)) {
		throw new Error(`BidirectionalIir: smoothingMs must be finite, got ${smoothingMs}`);
	}

	if (smoothingMs <= 0) {
		return { causal: 1, bidirectional: 1 };
	}

	const ratio = 1000 / sampleRate / smoothingMs;
	const causalPole = Math.exp(-ratio);
	const causal = -Math.expm1(-ratio);
	const omega = Math.min(ratio, Math.PI);
	const sinHalf = Math.sin(omega / 2);
	const causalMagnitude = causal / Math.hypot(causal, 2 * Math.sqrt(causalPole) * sinHalf);
	const transformedFrequency = 2 * sinHalf * Math.sqrt(causalMagnitude / (1 - causalMagnitude));
	const bidirectional = -Math.expm1(-2 * Math.asinh(transformedFrequency / 2));

	return { causal, bidirectional };
};

const runForwardPass = (buffer: Float64Array, alpha: number, initial: number): number => {
	const oneMinusAlpha = 1 - alpha;
	let y = initial;

	for (let index = 0; index < buffer.length; index++) {
		const x = buffer[index] ?? 0;

		y = alpha * x + oneMinusAlpha * y;
		buffer[index] = y;
	}

	return y;
};

const runBackwardPass = (buffer: Float64Array, alpha: number, initial: number): number => {
	const oneMinusAlpha = 1 - alpha;
	let y = initial;

	for (let index = buffer.length - 1; index >= 0; index--) {
		const x = buffer[index] ?? 0;

		y = alpha * x + oneMinusAlpha * y;
		buffer[index] = y;
	}

	return y;
};

export class BidirectionalIir {
	private readonly smoothingMs: number;
	private readonly alphaBidirectional: number;

	constructor(smoothingMs: number, sampleRate: number) {
		this.smoothingMs = smoothingMs;

		const alphas = bidirectionalAlphasOf(sampleRate, smoothingMs);

		this.alphaBidirectional = alphas.bidirectional;
	}

	applyBidirectional(buffer: Float64Array): void {
		if (this.smoothingMs <= 0 || buffer.length === 0) {
			return;
		}

		runForwardPass(buffer, this.alphaBidirectional, buffer[0] ?? 0);
		runBackwardPass(buffer, this.alphaBidirectional, buffer[buffer.length - 1] ?? 0);
	}

	applyForwardPass(input: Float64Array, state: { value: number }): void {
		if (this.smoothingMs <= 0) {
			return;
		}

		state.value = runForwardPass(input, this.alphaBidirectional, state.value);
	}

	applyBackwardPassInPlace(buffer: Float64Array): void {
		if (this.smoothingMs <= 0 || buffer.length === 0) {
			return;
		}

		runBackwardPass(buffer, this.alphaBidirectional, buffer[buffer.length - 1] ?? 0);
	}
}
