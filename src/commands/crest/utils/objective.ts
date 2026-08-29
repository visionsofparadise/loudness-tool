import { TruePeakAccumulator } from "../../../measurement/TruePeakAccumulator";
import { TruePeakUpsampler } from "../../../measurement/TruePeakUpsampler";
import { linearToDb } from "../../../utils/db";

const OVERSAMPLE_FACTOR = 4;
const FLUSH_OUTPUT_SAMPLES = 11 * OVERSAMPLE_FACTOR;

export const measureFrameTruePeakDb = (channels: ReadonlyArray<Float64Array>): number => {
	const channelCount = channels.length;

	if (channelCount === 0) {
		return linearToDb(0);
	}

	const frames = channels[0]?.length ?? 0;
	const accumulator = new TruePeakAccumulator(channelCount);

	accumulator.push(channels, frames);

	return linearToDb(accumulator.finalize());
};

export const truePeakAbs4x = (samples: Float64Array): number => {
	if (samples.length === 0) {
		return 0;
	}

	const upsampler = new TruePeakUpsampler();
	const aligned = new Float64Array(samples.length * OVERSAMPLE_FACTOR);
	const alignedCount = upsampler.upsample(samples, samples.length, aligned);
	let maxAbs = 0;

	for (let index = 0; index < alignedCount; index++) {
		const magnitude = Math.abs(aligned[index] ?? 0);

		if (magnitude > maxAbs) {
			maxAbs = magnitude;
		}
	}

	const tail = new Float64Array(FLUSH_OUTPUT_SAMPLES);
	const tailCount = upsampler.flush(tail);

	for (let index = 0; index < tailCount; index++) {
		const magnitude = Math.abs(tail[index] ?? 0);

		if (magnitude > maxAbs) {
			maxAbs = magnitude;
		}
	}

	return maxAbs;
};
