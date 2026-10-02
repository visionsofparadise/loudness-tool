import { describe, expect, it } from "vitest";
import { channelWeightsOf } from "./channelWeights";
import { createSine } from "../utils/testSignals";
import { IntegratedLufsAccumulator } from "./IntegratedLufsAccumulator";
import { preFilterCoefficients, rlbFilterCoefficients } from "./kWeighting";

describe("preFilterCoefficients", () => {
	it("returns the BS.1770-5 Table 1 constants at 48 kHz", () => {
		expect(preFilterCoefficients(48000)).toEqual({
			b0: 1.53512485958697,
			b1: -2.69169618940638,
			b2: 1.19839281085285,
			a1: -1.69065929318241,
			a2: 0.73248077421585,
		});
	});
});

describe("rlbFilterCoefficients", () => {
	it("returns the BS.1770-5 Table 2 constants at 48 kHz", () => {
		expect(rlbFilterCoefficients(48000)).toEqual({
			b0: 1.0,
			b1: -2.0,
			b2: 1.0,
			a1: -1.99004745483398,
			a2: 0.99007225036621,
		});
	});
});

describe("K-weighting response", () => {
	it.each([48000, 44100, 96000, 88200, 32000])("full-scale 997 Hz measures -3.01 LKFS ±0.1 at %i Hz", (sampleRate) => {
		const channels = createSine(sampleRate * 5, 1, sampleRate, 997, 1);
		const accumulator = new IntegratedLufsAccumulator(sampleRate, channelWeightsOf(1, 0));

		accumulator.push(channels, channels[0]?.length ?? 0);

		expect(Math.abs(accumulator.finalize() - -3.01)).toBeLessThanOrEqual(0.1);
	});
});
