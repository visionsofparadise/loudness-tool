import { describe, expect, it } from "vitest";
import { channelWeightsOf } from "./channelWeights";

const SURROUND = 1.41;

describe("channelWeightsOf", () => {
	it.each([
		{ name: "plain mono", channelCount: 1, channelMask: 0, weights: [1] },
		{ name: "plain stereo", channelCount: 2, channelMask: 0, weights: [1, 1] },
		{ name: "masked stereo 0x3", channelCount: 2, channelMask: 0x3, weights: [1, 1] },
		{ name: "5.1 back 0x3F", channelCount: 6, channelMask: 0x3f, weights: [1, 1, 1, 0, SURROUND, SURROUND] },
		{ name: "5.1 side 0x60F", channelCount: 6, channelMask: 0x60f, weights: [1, 1, 1, 0, SURROUND, SURROUND] },
		{
			name: "7.1 surround 0x63F",
			channelCount: 8,
			channelMask: 0x63f,
			weights: [1, 1, 1, 0, 1, 1, SURROUND, SURROUND],
		},
		{
			name: "6.1 with back centre 0x70F",
			channelCount: 7,
			channelMask: 0x70f,
			weights: [1, 1, 1, 0, 1, SURROUND, SURROUND],
		},
		{ name: "3/1 surround 0x107", channelCount: 4, channelMask: 0x107, weights: [1, 1, 1, SURROUND] },
		{
			name: "back centre beside a back pair 0x133",
			channelCount: 5,
			channelMask: 0x133,
			weights: [1, 1, SURROUND, SURROUND, 1],
		},
		{ name: "an undefined bit 0x40003", channelCount: 3, channelMask: 0x40003, weights: [1, 1, 1] },
		{ name: "SPEAKER_ALL 0x80000000", channelCount: 2, channelMask: 0x80000000, weights: [1, 1] },
		{ name: "plain 6-channel", channelCount: 6, channelMask: 0, weights: [1, 1, 1, 1, 1, 1] },
		{
			name: "channels past the popcount",
			channelCount: 8,
			channelMask: 0x3f,
			weights: [1, 1, 1, 0, SURROUND, SURROUND, 1, 1],
		},
		{
			name: "mask bits past the channel count",
			channelCount: 6,
			channelMask: 0x63f,
			weights: [1, 1, 1, 0, SURROUND, SURROUND],
		},
		{ name: "front of centre pair 0xC0", channelCount: 2, channelMask: 0xc0, weights: [1, 1] },
		{ name: "top bits 0x3F800", channelCount: 7, channelMask: 0x3f800, weights: [1, 1, 1, 1, 1, 1, 1] },
		{ name: "a stereo side pair 0x600", channelCount: 2, channelMask: 0x600, weights: [SURROUND, SURROUND] },
		{ name: "LFE alone 0x8", channelCount: 1, channelMask: 0x8, weights: [0] },
	])("weights $name", ({ channelCount, channelMask, weights }) => {
		expect(Array.from(channelWeightsOf(channelCount, channelMask))).toEqual(weights);
	});
});
