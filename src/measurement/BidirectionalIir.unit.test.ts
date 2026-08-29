import { describe, expect, it } from "vitest";
import { BidirectionalIir } from "./BidirectionalIir";

const causalMagnitudeOf = (sampleRate: number, smoothingMs: number): number => {
	const ratio = 1000 / sampleRate / smoothingMs;
	const causalPole = Math.exp(-ratio);
	const causal = -Math.expm1(-ratio);
	const sinHalf = Math.sin(Math.min(ratio, Math.PI) / 2);

	return causal / Math.hypot(causal, 2 * Math.sqrt(causalPole) * sinHalf);
};

const projectSineAmplitude = (input: Float64Array, omega: number, start: number, end: number): number => {
	let sineSquare = 0;
	let cosineSquare = 0;
	let sineCosine = 0;
	let inputSine = 0;
	let inputCosine = 0;

	for (let index = start; index < end; index++) {
		const sine = Math.sin(omega * index);
		const cosine = Math.cos(omega * index);
		const sample = input[index] ?? 0;

		sineSquare += sine * sine;
		cosineSquare += cosine * cosine;
		sineCosine += sine * cosine;
		inputSine += sample * sine;
		inputCosine += sample * cosine;
	}

	const determinant = sineSquare * cosineSquare - sineCosine * sineCosine;
	const sineAmplitude = (inputSine * cosineSquare - inputCosine * sineCosine) / determinant;
	const cosineAmplitude = (inputCosine * sineSquare - inputSine * sineCosine) / determinant;

	return Math.hypot(sineAmplitude, cosineAmplitude);
};

const makeFixture = (length: number, sampleRate: number): Float64Array => {
	const fixture = new Float64Array(length);

	for (let frameIndex = 0; frameIndex < length; frameIndex++) {
		const sine = Math.sin((2 * Math.PI * 100 * frameIndex) / sampleRate);
		const triangle = ((frameIndex % 256) / 256) * 2 - 1;

		fixture[frameIndex] = sine * 0.5 + triangle * 0.3 + 0.2;
	}

	return fixture;
};

describe("BidirectionalIir", () => {
	it("is identity at smoothingMs <= 0", () => {
		const input = Float64Array.from([0, 0.5, -0.25, 1, -1, 0.123, 0.999, 0]);

		for (const smoothingMs of [0, -1]) {
			const iir = new BidirectionalIir(smoothingMs, 48000);
			const bidirectional = Float64Array.from(input);

			iir.applyBidirectional(bidirectional);

			expect(bidirectional).toEqual(input);

			const forward = Float64Array.from(input);
			const state = { value: 0 };

			iir.applyForwardPass(forward, state);

			expect(forward).toEqual(input);

			const backward = Float64Array.from(input);

			iir.applyBackwardPassInPlace(backward);

			expect(backward).toEqual(input);
		}
	});

	it.each([
		{ sampleRate: 48000, smoothingMs: 10 },
		{ sampleRate: 1000, smoothingMs: 1 },
	])("matches the causal one-pole magnitude at $sampleRate Hz and $smoothingMs ms", ({ sampleRate, smoothingMs }) => {
		const ratio = 1000 / sampleRate / smoothingMs;
		const omega = Math.min(ratio, Math.PI);
		const periodSamples = (2 * Math.PI) / omega;
		const length = Math.max(16384, Math.ceil(periodSamples * 64));
		const input = new Float64Array(length);

		for (let index = 0; index < length; index++) {
			input[index] = Math.sin(omega * index);
		}

		new BidirectionalIir(smoothingMs, sampleRate).applyBidirectional(input);

		const actual = projectSineAmplitude(input, omega, Math.floor(length / 4), Math.floor((length * 3) / 4));
		const expected = causalMagnitudeOf(sampleRate, smoothingMs);

		expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-3);
	});

	it.each([0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])(
		"rejects sample rate %s",
		(sampleRate) => {
			expect(() => new BidirectionalIir(10, sampleRate)).toThrow("sampleRate must be positive and finite");
		},
	);

	it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])("rejects smoothing %s", (smoothingMs) => {
		expect(() => new BidirectionalIir(smoothingMs, 48000)).toThrow("smoothingMs must be finite");
	});

	it("zero-phase peaks stay aligned with a sine well below cutoff", () => {
		const sampleRate = 48000;
		const smoothingMs = 10;
		const iir = new BidirectionalIir(smoothingMs, sampleRate);
		const frequencyHz = 2;
		const periodSamples = sampleRate / frequencyHz;
		const length = Math.round(periodSamples * 8);
		const input = new Float64Array(length);

		for (let index = 0; index < length; index++) {
			input[index] = Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate);
		}

		const output = Float64Array.from(input);

		iir.applyBidirectional(output);

		const searchCenter = Math.floor(length / 2);
		const searchHalfWidth = Math.floor(periodSamples / 2);
		let inputPeakIndex = searchCenter;
		let inputPeakValue = input[searchCenter] ?? 0;

		for (let index = searchCenter - searchHalfWidth; index <= searchCenter + searchHalfWidth; index++) {
			const value = input[index] ?? 0;

			if (value > inputPeakValue) {
				inputPeakValue = value;
				inputPeakIndex = index;
			}
		}

		let outputPeakIndex = inputPeakIndex;
		let outputPeakValue = output[inputPeakIndex] ?? 0;

		for (let index = inputPeakIndex - searchHalfWidth; index <= inputPeakIndex + searchHalfWidth; index++) {
			const value = output[index] ?? 0;

			if (value > outputPeakValue) {
				outputPeakValue = value;
				outputPeakIndex = index;
			}
		}

		expect(Math.abs(outputPeakIndex - inputPeakIndex)).toBeLessThanOrEqual(Math.ceil(periodSamples * 0.01));
	});

	it("chunked forward-pass state matches a whole-array forward pass", () => {
		const sampleRate = 48000;
		const smoothingMs = 5;
		const iir = new BidirectionalIir(smoothingMs, sampleRate);
		const fixture = makeFixture(4096, sampleRate);
		const whole = Float64Array.from(fixture);
		const wholeState = { value: fixture[0] ?? 0 };

		iir.applyForwardPass(whole, wholeState);

		const chunked = new Float64Array(fixture.length);
		const chunkedState = { value: fixture[0] ?? 0 };
		let readOffset = 0;

		for (const splitPoint of [333, 1000, 2500, fixture.length]) {
			const chunk = fixture.slice(readOffset, splitPoint);

			iir.applyForwardPass(chunk, chunkedState);
			chunked.set(chunk, readOffset);
			readOffset = splitPoint;
		}

		for (let frameIndex = 0; frameIndex < fixture.length; frameIndex++) {
			expect(Math.abs((whole[frameIndex] ?? 0) - (chunked[frameIndex] ?? 0))).toBeLessThan(1e-12);
		}
	});

	it("forward then in-place backward matches applyBidirectional", () => {
		const sampleRate = 48000;
		const smoothingMs = 5;
		const iir = new BidirectionalIir(smoothingMs, sampleRate);
		const fixture = makeFixture(4096, sampleRate);
		const reference = Float64Array.from(fixture);
		const composed = Float64Array.from(fixture);

		iir.applyBidirectional(reference);

		const state = { value: composed[0] ?? 0 };

		iir.applyForwardPass(composed, state);
		iir.applyBackwardPassInPlace(composed);

		for (let frameIndex = 0; frameIndex < fixture.length; frameIndex++) {
			expect(Math.abs((reference[frameIndex] ?? 0) - (composed[frameIndex] ?? 0))).toBeLessThan(1e-12);
		}
	});

	it("does not mutate the buffer when smoothingMs is 0", () => {
		const iir = new BidirectionalIir(0, 48000);
		const input = Float64Array.from([0, 0.25, 0.5, 0.75, 1]);
		const reference = Float64Array.from(input);

		iir.applyBidirectional(input);
		iir.applyForwardPass(input, { value: 0 });
		iir.applyBackwardPassInPlace(input);

		expect(input).toEqual(reference);
	});
});
