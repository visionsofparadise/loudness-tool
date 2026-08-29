import { describe, expect, it } from "vitest";
import { dbToLinear } from "./db";
import { createLevelSegments, createSine } from "./testSignals";

describe("createSine", () => {
	it("scales by the given amplitude", () => {
		const channels = createSine(8, 1, 8, 1, 0.5);

		expect(channels[0]?.[2]).toBeCloseTo(0.5, 12);
	});
});

describe("createLevelSegments", () => {
	it("concatenates per-segment sines at the stated levels across channels", () => {
		const sampleRate = 48000;
		const channels = createLevelSegments(
			[
				{ seconds: 0.01, frequency: 1000, db: -20 },
				{ seconds: 0.01, frequency: 1000, db: -30 },
			],
			sampleRate,
			2,
		);
		const firstLength = Math.round(0.01 * sampleRate);
		const firstAmplitude = dbToLinear(-20);
		const secondAmplitude = dbToLinear(-30);

		expect(channels).toHaveLength(2);
		expect(channels[0]?.length).toBe(firstLength * 2);
		expect(channels[1]?.length).toBe(firstLength * 2);

		let firstPeak = 0;
		let secondPeak = 0;

		for (let frameIndex = 0; frameIndex < firstLength; frameIndex++) {
			firstPeak = Math.max(firstPeak, Math.abs(channels[0]?.[frameIndex] ?? 0));
			secondPeak = Math.max(secondPeak, Math.abs(channels[0]?.[firstLength + frameIndex] ?? 0));
		}

		expect(firstPeak).toBeCloseTo(firstAmplitude, 6);
		expect(secondPeak).toBeCloseTo(secondAmplitude, 6);
		expect(channels[0]?.[0]).toBe(channels[1]?.[0]);
		expect(channels[0]?.[firstLength]).toBe(channels[1]?.[firstLength]);
	});
});
