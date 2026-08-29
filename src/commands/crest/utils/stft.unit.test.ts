import { describe, expect, it } from "vitest";
import { linearToDb } from "../../../utils/db";
import { TruePeakArgmaxAccumulator } from "./TruePeakArgmaxAccumulator";
import { hopSizeOf, stftFrameCount, streamLatticeTrajectory, type LatticeAnalysisSource } from "./stft";
import { LATTICE_ORDER } from "./lattice";
import { groupDelayLambda } from "./search";

const SAMPLE_RATE = 48_000;

const sourceOf = (channels: ReadonlyArray<Float64Array>): LatticeAnalysisSource => ({
	channelCount: channels.length,
	signalLength: channels[0]?.length ?? 0,
	async *blocks() {
		yield channels;
	},
});

describe("stft geometry", () => {
	it("uses 75% overlap", () => {
		expect(hopSizeOf(2048)).toBe(512);
		expect(hopSizeOf(4)).toBe(1);
		expect(hopSizeOf(2)).toBe(0);
	});

	it("counts frames from signal length", () => {
		expect(stftFrameCount(2048, 2048, 512)).toBe(1);
		expect(stftFrameCount(2048 + 512 * 3, 2048, 512)).toBe(4);
		expect(stftFrameCount(2047, 2048, 512)).toBe(0);
		expect(stftFrameCount(4096, 2048, 0)).toBe(0);
	});
});

describe("streamLatticeTrajectory", () => {
	it("returns no frames for a short signal", async () => {
		const result = await streamLatticeTrajectory(sourceOf([new Float64Array(64)]), 2048, 512, {
			globalTruePeakDb: linearToDb(0.5),
			peakInputSample: 0,
			sampleRate: SAMPLE_RATE,
			lambda: 0,
		});

		expect(result.frameCount).toBe(0);
	});

	it("leaves a silent frame unbound", async () => {
		const result = await streamLatticeTrajectory(sourceOf([new Float64Array(2048)]), 2048, 512, {
			globalTruePeakDb: linearToDb(0.5),
			peakInputSample: 0,
			sampleRate: SAMPLE_RATE,
			lambda: groupDelayLambda(SAMPLE_RATE, LATTICE_ORDER),
		});

		expect(result.frameCount).toBe(1);
		expect(result.bindingMask).toEqual([false]);
		expect(result.trajectory.amountEnv[0]).toBe(0);
	});

	it("routes a tail-only maximum to the last analyzed frame", async () => {
		const frameSize = 64;
		const hopSize = 32;
		const signal = new Float64Array(96);

		signal.set([-0.08388812094926834, 0.6030386090278625, -0.7042242288589478], signal.length - 3);

		const accumulator = new TruePeakArgmaxAccumulator(1);

		accumulator.push([signal], signal.length);

		const globalTruePeak = accumulator.finalize();
		const result = await streamLatticeTrajectory(sourceOf([signal]), frameSize, hopSize, {
			globalTruePeakDb: globalTruePeak.truePeakDb + 10,
			peakInputSample: globalTruePeak.peakInputSample,
			sampleRate: SAMPLE_RATE,
			lambda: 0,
		});

		expect(result.frameCount).toBe(2);
		expect(result.bindingMask).toEqual([false, true]);
	});

	it("is deterministic", async () => {
		const signal = new Float64Array(4096);

		for (let index = 0; index < signal.length; index++) {
			signal[index] = Math.sin((2 * Math.PI * 120 * index) / SAMPLE_RATE) * 0.2;
			if (index % 800 === 0) {
				signal[index] = 0.9;
			}
		}

		const search = {
			globalTruePeakDb: linearToDb(0.9),
			peakInputSample: 0,
			sampleRate: SAMPLE_RATE,
			lambda: groupDelayLambda(SAMPLE_RATE, LATTICE_ORDER),
		};
		const a = await streamLatticeTrajectory(sourceOf([signal]), 2048, 512, search);
		const b = await streamLatticeTrajectory(sourceOf([signal]), 2048, 512, search);

		expect(Array.from(b.trajectory.amountEnv)).toEqual(Array.from(a.trajectory.amountEnv));
		expect(b.bindingMask).toEqual(a.bindingMask);
	});
});
