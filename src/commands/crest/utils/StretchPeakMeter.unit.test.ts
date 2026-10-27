import { describe, expect, it } from "vitest";
import { FLUSH_FRAMES } from "../../../measurement/TruePeakUpsampler";
import { createNoise } from "../../../utils/testSignals";
import { StretchPeakMeter } from "./StretchPeakMeter";
import { stretchPeaksOf, upsampledOf } from "./testBlendOracle";

const STRETCH_FRAMES = 48;

describe("StretchPeakMeter", () => {
	it.each([1, 13, 65536])(
		"meters blocks of %i frames as one whole-file upsample bucketed per stretch",
		(blockFrames) => {
			const frameCount = 1000;
			const channels = createNoise(frameCount, 2, 19);
			const loud = channels[1];

			if (loud !== undefined) {
				loud[500] = 1.5;
				loud[501] = -1.5;
			}

			const meter = new StretchPeakMeter({ stretchFrames: STRETCH_FRAMES, channelCount: 2 });

			for (let first = 0; first < frameCount; first += blockFrames) {
				const take = Math.min(blockFrames, frameCount - first);

				meter.push(
					channels.map((channel) => channel.slice(first, first + take)),
					take,
				);
			}

			const expected = stretchPeaksOf(channels.map(upsampledOf), frameCount, STRETCH_FRAMES);

			expect(Array.from(meter.finish())).toEqual(Array.from(expected));
		},
	);

	it("takes the last stretch's peak from a click on the second channel's last frame as it rings out", () => {
		const frameCount = 100;
		const channels = [new Float64Array(frameCount), new Float64Array(frameCount)];
		const ringing = channels[1];

		if (ringing !== undefined) {
			ringing[frameCount - 1] = 1;
		}

		const meter = new StretchPeakMeter({ stretchFrames: STRETCH_FRAMES, channelCount: 2 });

		meter.push(channels, frameCount);

		const peaks = meter.finish();
		const upsampled = upsampledOf(ringing ?? new Float64Array(0));
		const tailPeak = Math.max(...upsampled.subarray(frameCount * 4, (frameCount + FLUSH_FRAMES) * 4).map(Math.abs));
		const framePeak = Math.max(...upsampled.subarray(0, frameCount * 4).map(Math.abs));

		expect(tailPeak).toBeGreaterThan(framePeak);
		expect(peaks[peaks.length - 1]).toBe(tailPeak);
	});
});
