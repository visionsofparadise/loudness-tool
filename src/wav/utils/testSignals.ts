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
): Array<Float64Array> =>
	createPlanar(
		frameCount,
		channelCount,
		(frameIndex) => Math.sin((2 * Math.PI * frequency * frameIndex) / sampleRate) * 0.75,
	);

export const createRamp = (frameCount: number, channelCount: number): Array<Float64Array> =>
	createPlanar(frameCount, channelCount, (frameIndex) =>
		frameCount <= 1 ? 0 : -0.9 + (1.8 * frameIndex) / (frameCount - 1),
	);
