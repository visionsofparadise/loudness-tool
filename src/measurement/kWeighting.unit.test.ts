import { describe, expect, it } from "vitest";
import { channelWeightsOf } from "./channelWeights";
import { createSine } from "../utils/testSignals";
import { IntegratedLufsAccumulator } from "./IntegratedLufsAccumulator";
import { type BiquadCoefficients, preFilterCoefficients, rlbFilterCoefficients } from "./kWeighting";

const TABLE_1: BiquadCoefficients = {
	b0: 1.53512485958697,
	b1: -2.69169618940638,
	b2: 1.19839281085285,
	a1: -1.69065929318241,
	a2: 0.73248077421585,
};

const TABLE_2: BiquadCoefficients = {
	b0: 1.0,
	b1: -2.0,
	b2: 1.0,
	a1: -1.99004745483398,
	a2: 0.99007225036621,
};

const magnitudeDbOf = (filter: BiquadCoefficients, frequency: number, sampleRate: number): number => {
	const omega = (2 * Math.PI * frequency) / sampleRate;
	const re = (b0: number, b1: number, b2: number): number => b0 + b1 * Math.cos(omega) + b2 * Math.cos(2 * omega);
	const im = (b1: number, b2: number): number => -b1 * Math.sin(omega) - b2 * Math.sin(2 * omega);
	const numerator = Math.hypot(re(filter.b0, filter.b1, filter.b2), im(filter.b1, filter.b2));
	const denominator = Math.hypot(re(1, filter.a1, filter.a2), im(filter.a1, filter.a2));

	return 20 * Math.log10(numerator / denominator);
};

const cascadeDbOf = (shelf: BiquadCoefficients, highPass: BiquadCoefficients, frequency: number, sampleRate: number) =>
	magnitudeDbOf(shelf, frequency, sampleRate) + magnitudeDbOf(highPass, frequency, sampleRate);

describe("preFilterCoefficients", () => {
	it("returns the BS.1770-5 Table 1 constants at 48 kHz", () => {
		expect(preFilterCoefficients(48000)).toEqual(TABLE_1);
	});
});

describe("rlbFilterCoefficients", () => {
	it("returns the BS.1770-5 Table 2 constants at 48 kHz", () => {
		expect(rlbFilterCoefficients(48000)).toEqual(TABLE_2);
	});
});

describe("K-weighting response", () => {
	it.each([
		[8000, 0.04],
		[11025, 0.04],
		[16000, 0.01],
		[22050, 0.01],
		[32000, 0.01],
		[44100, 0.01],
		[88200, 0.01],
		[96000, 0.01],
		[192000, 0.01],
		[768000, 0.01],
	])("matches the 48 kHz cascade at %i Hz within %f dB", (sampleRate, tolerance) => {
		const shelf = preFilterCoefficients(sampleRate);
		const highPass = rlbFilterCoefficients(sampleRate);
		const top = Math.min(0.45 * sampleRate, 20000);
		let worst = 0;

		for (let index = 0; index < 200; index++) {
			const frequency = 20 * Math.pow(top / 20, index / 199);
			const deviation =
				cascadeDbOf(shelf, highPass, frequency, sampleRate) - cascadeDbOf(TABLE_1, TABLE_2, frequency, 48000);

			worst = Math.max(worst, Math.abs(deviation));
		}

		expect(worst).toBeLessThanOrEqual(tolerance);
	});

	it.each([48000, 44100, 96000, 88200, 32000])("full-scale 997 Hz measures -3.01 LKFS ±0.1 at %i Hz", (sampleRate) => {
		const channels = createSine(sampleRate * 5, 1, sampleRate, 997, 1);
		const accumulator = new IntegratedLufsAccumulator(sampleRate, channelWeightsOf(1, 0));

		accumulator.push(channels, channels[0]?.length ?? 0);

		expect(Math.abs(accumulator.finalize() - -3.01)).toBeLessThanOrEqual(0.1);
	});
});
