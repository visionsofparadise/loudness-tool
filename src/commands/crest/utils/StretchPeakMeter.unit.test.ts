import { describe, expect, it } from "vitest";
import { createNoise } from "../../../utils/testSignals";
import { OVERSAMPLE_FACTOR } from "./render";
import { StretchPeakMeter } from "./StretchPeakMeter";
import { upsampledOf } from "./testBlendOracle";

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

			const expected = new Float64Array(Math.ceil(frameCount / STRETCH_FRAMES));

			for (const channel of channels) {
				const upsampled = upsampledOf(channel);

				for (let index = 0; index < frameCount * OVERSAMPLE_FACTOR; index++) {
					const stretchIndex = Math.floor(index / OVERSAMPLE_FACTOR / STRETCH_FRAMES);

					expected[stretchIndex] = Math.max(expected[stretchIndex] ?? 0, Math.abs(upsampled[index] ?? 0));
				}
			}

			expect(Array.from(meter.finish())).toEqual(Array.from(expected));
		},
	);
});
