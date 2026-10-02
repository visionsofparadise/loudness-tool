const SURROUND_WEIGHT = 1.41;
const LOW_FREQUENCY = 0x8;
const BACK_LEFT_RIGHT = 0x10 | 0x20;
const BACK_CENTER = 0x100;
const SIDE_LEFT_RIGHT = 0x200 | 0x400;
const MASK_BITS = 32;

const statedMaskOf = (channelCount: number, channelMask: number): number => {
	let stated = 0;
	let assigned = 0;

	for (let bit = 0; bit < MASK_BITS && assigned < channelCount; bit++) {
		const flag = (1 << bit) >>> 0;

		if ((channelMask & flag) !== 0) {
			stated = (stated | flag) >>> 0;
			assigned++;
		}
	}

	return stated;
};

const bitWeightOf = (flag: number, statedMask: number): number => {
	const hasSides = (statedMask & SIDE_LEFT_RIGHT) !== 0;

	if (flag === LOW_FREQUENCY) {
		return 0;
	}

	if ((flag & SIDE_LEFT_RIGHT) !== 0) {
		return SURROUND_WEIGHT;
	}

	if ((flag & BACK_LEFT_RIGHT) !== 0) {
		return hasSides ? 1 : SURROUND_WEIGHT;
	}

	if (flag === BACK_CENTER) {
		return hasSides || (statedMask & BACK_LEFT_RIGHT) !== 0 ? 1 : SURROUND_WEIGHT;
	}

	return 1;
};

// eslint-disable-next-line comment-rules/no-restricted-comments
// Weights per ITU-R BS.1770-5 Annex 3 Table 4 and stage 3 (LFE excluded) at the ITU-R BS.2051-3 loudspeaker positions; channel k takes the k-th set bit of dwChannelMask per Microsoft "Multiple channel audio data and WAVE files"; back and back-centre bits resolve by Microsoft "Mapping Stream Formats to Speaker Configurations" (KSAUDIO_SPEAKER_5POINT1, KSAUDIO_SPEAKER_7POINT1_SURROUND, KSAUDIO_SPEAKER_SURROUND) and the ITU-R BS.775 3/1 surround feed.
export const channelWeightsOf = (channelCount: number, channelMask: number): Float64Array => {
	const statedMask = statedMaskOf(channelCount, channelMask >>> 0);
	const weights = new Float64Array(channelCount).fill(1);
	let channelIndex = 0;

	for (let bit = 0; bit < MASK_BITS && channelIndex < channelCount; bit++) {
		const flag = (1 << bit) >>> 0;

		if ((statedMask & flag) !== 0) {
			weights[channelIndex] = bitWeightOf(flag, statedMask);
			channelIndex++;
		}
	}

	return weights;
};
