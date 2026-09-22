import { afterEach, describe, expect, it } from "vitest";
import { dbToLinear } from "../../../utils/db";
import { SampleFile } from "../../../utils/SampleFile";
import { Scratch } from "../../../utils/Scratch";
import { type Anchors, gainDbAt } from "./curve";
import { renderEnvelope } from "./envelope";
import { holdHalfWidthOf, windowSamplesFromMs } from "./window";

const SAMPLE_RATE = 48000;

const ANCHORS: Anchors = {
	floorDb: null,
	pivotDb: -30,
	limitDb: -3,
	B: 6,
	peakGainDb: 2,
};

const collect = async (file: SampleFile): Promise<Float64Array> => {
	const chunks: Array<Float64Array> = [];
	let total = 0;

	for await (const chunk of file.blocks()) {
		chunks.push(chunk);
		total += chunk.length;
	}

	const merged = new Float64Array(total);
	let cursor = 0;

	for (const chunk of chunks) {
		merged.set(chunk, cursor);
		cursor += chunk.length;
	}

	return merged;
};

const randomLevels = (length: number, seed: number): Float64Array => {
	const levels = new Float64Array(length);
	let state = seed >>> 0;

	for (let index = 0; index < length; index++) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		levels[index] = -60 + (66 * state) / 0x1_00_00_00_00;
	}

	return levels;
};

describe("renderEnvelope", () => {
	let scratch: Scratch | undefined;

	afterEach(async () => {
		if (scratch !== undefined) {
			await scratch.dispose();
			scratch = undefined;
		}
	});

	const renderLevels = async (levels: Float64Array, holdHalfWidth: number): Promise<Float64Array> => {
		if (scratch === undefined) {
			throw new Error("scratch must be created before rendering");
		}

		const detection = await SampleFile.create(scratch, "detection");

		await detection.append(levels, levels.length);

		const dest = await SampleFile.create(scratch, "envelope");

		await renderEnvelope({ detectionEnvelope: detection, dest, anchors: ANCHORS, holdHalfWidth });

		const envelope = await collect(dest);

		await detection.close();
		await dest.close();

		return envelope;
	};

	it("reduces an isolated event symmetrically, ahead of the event, without discontinuities", async () => {
		scratch = await Scratch.create();

		const length = 4000;
		const holdHalfWidth = holdHalfWidthOf(windowSamplesFromMs(1, SAMPLE_RATE));
		const eventIndex = 2000;
		const bedLevelDb = -40;
		const eventLevelDb = 0;
		const levels = new Float64Array(length);

		levels.fill(bedLevelDb);
		levels[eventIndex] = eventLevelDb;

		const envelope = await renderLevels(levels, holdHalfWidth);
		const bedGain = Math.pow(10, gainDbAt(bedLevelDb, ANCHORS) / 20);
		const eventGain = Math.pow(10, gainDbAt(eventLevelDb, ANCHORS) / 20);

		expect(envelope.length).toBe(length);
		expect(envelope[eventIndex]).toBeCloseTo(eventGain, 5);
		expect(envelope[eventIndex] ?? 0).toBeLessThan(bedGain);

		const ahead = envelope[eventIndex - holdHalfWidth] ?? 0;
		const behind = envelope[eventIndex + holdHalfWidth] ?? 0;

		expect(ahead).toBeLessThan(bedGain);
		expect(behind).toBeLessThan(bedGain);
		expect(Math.abs(ahead - behind)).toBeLessThan(1e-4);

		expect(envelope[0] ?? 0).toBeCloseTo(bedGain, 2);
		expect(envelope[length - 1] ?? 0).toBeCloseTo(bedGain, 2);

		let maxDelta = 0;

		for (let index = 1; index < envelope.length; index++) {
			const value = envelope[index] ?? 0;

			expect(Number.isFinite(value)).toBe(true);
			expect(value).toBeGreaterThan(0);

			const delta = Math.abs(value - (envelope[index - 1] ?? 0));

			if (delta > maxDelta) {
				maxDelta = delta;
			}
		}

		expect(maxDelta).toBeLessThan(Math.abs(bedGain - eventGain));
	});

	it("clamps the event sample to the curve assignment", async () => {
		scratch = await Scratch.create();

		const length = 2048;
		const eventIndex = 1024;
		const levels = new Float64Array(length);

		levels.fill(-40);
		levels[eventIndex] = 3;

		const envelope = await renderLevels(levels, holdHalfWidthOf(windowSamplesFromMs(1, SAMPLE_RATE)));
		const assigned = Math.pow(10, gainDbAt(3, ANCHORS) / 20);

		expect(Math.abs((envelope[eventIndex] ?? 0) - assigned)).toBeLessThan(1e-6);
	});

	it("never exceeds the raw curve gain at any sample", async () => {
		scratch = await Scratch.create();

		const levels = randomLevels(5000, 0x5eed_0001);
		const envelope = await renderLevels(levels, 24);

		expect(envelope.length).toBe(levels.length);

		for (let index = 0; index < levels.length; index++) {
			const rawGain = dbToLinear(gainDbAt(levels[index] ?? 0, ANCHORS));

			expect(envelope[index] ?? Infinity).toBeLessThanOrEqual(rawGain * (1 + 1e-6));
		}
	});

	it("is the identity of the raw gain at hold half-width 0", async () => {
		scratch = await Scratch.create();

		const levels = randomLevels(3000, 0x5eed_0002);
		const envelope = await renderLevels(levels, 0);

		expect(envelope.length).toBe(levels.length);

		for (let index = 0; index < levels.length; index++) {
			const rawGain = dbToLinear(gainDbAt(levels[index] ?? 0, ANCHORS));

			expect(Math.abs((envelope[index] ?? 0) - rawGain) / rawGain).toBeLessThan(1e-6);
		}
	});

	it("appends nothing for a zero-frame detection envelope", async () => {
		scratch = await Scratch.create();

		expect((await renderLevels(new Float64Array(0), 24)).length).toBe(0);
	});
});
