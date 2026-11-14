import { afterEach, describe, expect, it } from "vitest";
import { dbToLinear } from "../../../utils/db";
import { SampleFile } from "../../../utils/SampleFile";
import { Scratch } from "../../../utils/Scratch";
import { type Anchors, gainDbAt } from "./curve";
import { renderEnvelope } from "./envelope";

const ANCHORS: Anchors = {
	floorDb: -45,
	pivotDb: -25,
	kneeDb: -18,
	limitDb: -6,
	ceilingDb: -1,
	B: 9,
	peakGainDb: 5,
};

const randomLevels = (length: number, seed: number, lowDb: number, spanDb: number): Float64Array => {
	const levels = new Float64Array(length);
	let state = seed >>> 0;

	for (let index = 0; index < length; index++) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		levels[index] = lowDb + (spanDb * state) / 0x1_00_00_00_00;
	}

	return levels;
};

const fileOf = async (scratch: Scratch, label: string, values: Float64Array): Promise<SampleFile> => {
	const file = await SampleFile.create(scratch, label);

	await file.append(values, values.length);

	return file;
};

describe("renderEnvelope through sample files", () => {
	let scratch: Scratch | undefined;

	afterEach(async () => {
		await scratch?.dispose();
		scratch = undefined;
	});

	it("never exceeds the raw gain at any frame across several blocks", async () => {
		const activeScratch = await Scratch.create();

		scratch = activeScratch;

		const frameCount = 150_000;
		const loudnessDb = randomLevels(frameCount, 0x5eed_0101, -60, 50);
		const peakDb = randomLevels(frameCount, 0x5eed_0102, -40, 42);
		const loudnessEnvelope = await fileOf(activeScratch, "loudness", loudnessDb);
		const peakEnvelope = await fileOf(activeScratch, "peak", peakDb);
		const dest = await SampleFile.create(activeScratch, "envelope");

		await renderEnvelope({ loudnessEnvelope, peakEnvelope, dest, anchors: ANCHORS, holdHalfWidth: 960 });

		expect(dest.frameCount).toBe(frameCount);

		let frameIndex = 0;

		for await (const chunk of dest.blocks()) {
			for (const gain of chunk) {
				const rawGain = dbToLinear(gainDbAt(loudnessDb[frameIndex] ?? 0, peakDb[frameIndex] ?? 0, ANCHORS));

				expect(gain).toBeLessThanOrEqual(rawGain * (1 + 1e-6));
				frameIndex++;
			}
		}

		expect(frameIndex).toBe(frameCount);
	});
});
