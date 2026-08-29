import { afterEach, describe, expect, it } from "vitest";
import { BidirectionalIir } from "../../../measurement/BidirectionalIir";
import { SampleFile } from "../../../utils/SampleFile";
import { Scratch } from "../../../utils/Scratch";
import { type Anchors, gainDbAt } from "./curve";
import { renderEnvelope } from "./envelope";
import { windowSamplesFromMs } from "./window";

const SAMPLE_RATE = 48000;

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

describe("renderEnvelope", () => {
	let scratch: Scratch | undefined;

	afterEach(async () => {
		if (scratch !== undefined) {
			await scratch.dispose();
			scratch = undefined;
		}
	});

	it("reduces an isolated event symmetrically, ahead of the event, without discontinuities", async () => {
		scratch = await Scratch.create();

		const length = 4000;
		const halfWidth = windowSamplesFromMs(1, SAMPLE_RATE);
		const eventIndex = 2000;
		const anchors: Anchors = {
			floorDb: null,
			pivotDb: -30,
			limitDb: -3,
			B: 6,
			peakGainDb: 2,
		};
		const bedLevelDb = -40;
		const eventLevelDb = 0;
		const detection = await SampleFile.create(scratch, "detection");
		const levels = new Float64Array(length);

		levels.fill(bedLevelDb);
		levels[eventIndex] = eventLevelDb;

		await detection.append(levels, levels.length);

		const dest = await SampleFile.create(scratch, "envelope");
		const iir = new BidirectionalIir(1, SAMPLE_RATE);

		await renderEnvelope({
			detectionEnvelope: detection,
			dest,
			scratch,
			anchors,
			iir,
			halfWidth,
			label: "event",
		});

		const envelope = await collect(dest);
		const bedGain = Math.pow(10, gainDbAt(bedLevelDb, anchors) / 20);
		const eventGain = Math.pow(10, gainDbAt(eventLevelDb, anchors) / 20);

		expect(envelope.length).toBe(length);
		expect(envelope[eventIndex]).toBeCloseTo(eventGain, 5);
		expect(envelope[eventIndex] ?? 0).toBeLessThan(bedGain);

		const ahead = envelope[eventIndex - halfWidth] ?? 0;
		const behind = envelope[eventIndex + halfWidth] ?? 0;

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

		await detection.close();
		await dest.close();
	});

	it("clamps the event sample to the curve assignment", async () => {
		scratch = await Scratch.create();

		const length = 2048;
		const halfWidth = windowSamplesFromMs(1, SAMPLE_RATE);
		const eventIndex = 1024;
		const anchors: Anchors = {
			floorDb: null,
			pivotDb: -30,
			limitDb: -3,
			B: 6,
			peakGainDb: 2,
		};
		const detection = await SampleFile.create(scratch, "detection");
		const levels = new Float64Array(length);

		levels.fill(-40);
		levels[eventIndex] = 3;

		await detection.append(levels, levels.length);

		const dest = await SampleFile.create(scratch, "envelope");

		await renderEnvelope({
			detectionEnvelope: detection,
			dest,
			scratch,
			anchors,
			iir: new BidirectionalIir(1, SAMPLE_RATE),
			halfWidth,
			label: "clamp",
		});

		const envelope = await collect(dest);
		const assigned = Math.pow(10, gainDbAt(3, anchors) / 20);

		expect(Math.abs((envelope[eventIndex] ?? 0) - assigned)).toBeLessThan(1e-6);

		await detection.close();
		await dest.close();
	});
});
