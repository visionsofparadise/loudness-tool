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

export interface SpeechLike {
	readonly channel: Float64Array;
	readonly activeSpans: ReadonlyArray<readonly [number, number]>;
}

const UNIFORM_NOISE_RMS = 1 / Math.sqrt(3);
const SYLLABLE_RAMP_SECONDS = 0.02;
const SPIKE_SPACING_SECONDS = 0.05;
const COUGH_SECONDS = 0.15;

export const createSpeechLike = (args: {
	readonly seconds: number;
	readonly sampleRate: number;
	readonly roomToneDb: number;
	readonly syllableDb: readonly [number, number];
	readonly spike: { readonly aboveDb: number; readonly db: number } | null;
	readonly coughDb: number | null;
	readonly seed: number;
}): SpeechLike => {
	const { seconds, sampleRate, roomToneDb, syllableDb, spike, coughDb, seed } = args;
	const frameCount = Math.round(seconds * sampleRate);
	let state = seed >>> 0;
	const uniform = (): number => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

		return state / 0x100000000;
	};
	const noise = (): number => (2 * uniform() - 1) / UNIFORM_NOISE_RMS;
	const channel = new Float64Array(frameCount).map(() => noise() * dbToLinear(roomToneDb));
	const activeSpans: Array<readonly [number, number]> = [];
	const rampFrames = Math.round(SYLLABLE_RAMP_SECONDS * sampleRate);
	const spikeSpacing = Math.round(SPIKE_SPACING_SECONDS * sampleRate);
	const lastStart = frameCount - Math.round(0.3 * sampleRate);
	let start = Math.round(0.3 * sampleRate);

	for (;;) {
		const length = Math.round((0.12 + 0.18 * uniform()) * sampleRate);

		if (start + length >= lastStart) {
			break;
		}

		const levelDb = syllableDb[0] + (syllableDb[1] - syllableDb[0]) * uniform();
		const isSpiked = spike !== null && levelDb > spike.aboveDb;

		for (let offset = 0; offset < length; offset++) {
			const edge = Math.min(offset, length - 1 - offset);
			const ramp = edge < rampFrames ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / rampFrames) : 1;
			const index = start + offset;
			const isSpike = isSpiked && edge >= rampFrames && (offset - rampFrames) % spikeSpacing === 0;

			channel[index] =
				(channel[index] ?? 0) + (isSpike ? dbToLinear(spike.db) : noise() * dbToLinear(levelDb) * ramp);
		}

		activeSpans.push([start, start + length]);
		start += length + Math.round((0.05 + 0.25 * uniform()) * sampleRate);
	}

	if (coughDb !== null) {
		const coughStart = Math.round((seconds / 2) * sampleRate);
		const coughFrames = Math.round(COUGH_SECONDS * sampleRate);

		for (let offset = 0; offset < coughFrames; offset++) {
			const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * offset) / (coughFrames - 1));
			const index = coughStart + offset;

			channel[index] = (channel[index] ?? 0) + noise() * dbToLinear(coughDb) * window;
		}

		activeSpans.push([coughStart, coughStart + coughFrames]);
	}

	return { channel, activeSpans };
};
