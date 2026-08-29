import { dbToLinear } from "./db";

const createPlanar = (
	frameCount: number,
	channelCount: number,
	sampleOf: (frameIndex: number, channelIndex: number) => number,
): Array<Float64Array> => {
	const channels: Array<Float64Array> = [];

	for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
		const channel = new Float64Array(frameCount);

		for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
			channel[frameIndex] = sampleOf(frameIndex, channelIndex);
		}

		channels.push(channel);
	}

	return channels;
};

export const createNoise = (frameCount: number, channelCount: number, seed: number): Array<Float64Array> => {
	let state = seed >>> 0;

	return createPlanar(frameCount, channelCount, () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

		return state / 0x80000000 - 1;
	});
};

export const createSine = (
	frameCount: number,
	channelCount: number,
	sampleRate: number,
	frequency: number,
	amplitude: number,
): Array<Float64Array> =>
	createPlanar(
		frameCount,
		channelCount,
		(frameIndex) => Math.sin((2 * Math.PI * frequency * frameIndex) / sampleRate) * amplitude,
	);

export const createRamp = (frameCount: number, channelCount: number): Array<Float64Array> =>
	createPlanar(frameCount, channelCount, (frameIndex) =>
		frameCount <= 1 ? 0 : -0.9 + (1.8 * frameIndex) / (frameCount - 1),
	);

export const createLevelSegments = (
	segments: ReadonlyArray<{ seconds: number; frequency: number; db: number }>,
	sampleRate: number,
	channelCount: number,
): Array<Float64Array> => {
	const frameCounts = segments.map((segment) => Math.round(segment.seconds * sampleRate));
	const frameCount = frameCounts.reduce((total, count) => total + count, 0);

	return createPlanar(frameCount, channelCount, (frameIndex) => {
		let cursor = 0;

		for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
			const segmentFrameCount = frameCounts[segmentIndex] ?? 0;

			if (frameIndex < cursor + segmentFrameCount) {
				const segment = segments[segmentIndex];
				const localIndex = frameIndex - cursor;

				return (
					dbToLinear(segment?.db ?? 0) *
					Math.sin((2 * Math.PI * (segment?.frequency ?? 0) * localIndex) / sampleRate)
				);
			}

			cursor += segmentFrameCount;
		}

		return 0;
	});
};
