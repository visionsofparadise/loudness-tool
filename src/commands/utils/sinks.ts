import { writeTextToStream } from "../../utils/writeToStream";
import { wavOutputBitDepthOf, type SourceBitDepth } from "../../wav/utils/wavFormat";
import { descriptorOf, writableOf } from "./stdioPath";
import { rawBitDepthOf, type StreamOptions } from "./streamOptions";
import type { StreamFormat } from "../../wav/WavReader";
import type { WavSink } from "../../wav/WavWriter";

export interface OutputRequest {
	readonly path: string;
	readonly stream: StreamOptions;
}

export interface AudioOutput {
	readonly sink: WavSink;
	readonly container: "wav" | "raw";
	readonly bitDepth: SourceBitDepth;
	readonly channelMask: number;
}

// eslint-disable-next-line comment-rules/no-restricted-comments
// The channel masks of FFmpeg 8.0 libavutil/channel_layout.c av_channel_layout_default, the first layout of channel_layout_map with the count; 16 and 24 default to 9.1.6 and 22.2, which no WAVE mask states, so -1 equals no input mask. A count without a default, such as 9, leaves the input's layout as it is.
const DEFAULT_LAYOUT_MASKS: Readonly<Record<number, number>> = {
	1: 0x4,
	2: 0x3,
	3: 0xb,
	4: 0x107,
	5: 0x37,
	6: 0x3f,
	7: 0x70f,
	8: 0x63f,
	10: 0x2d60f,
	12: 0x2d63f,
	14: 0x2d6ff,
	16: -1,
	24: -1,
};

const CHANNELS_KEPT = "loudness-tool keeps the input's channels";

const hexOf = (mask: number): string => `0x${mask.toString(16)}`;

const sinkOf = (path: string): WavSink => {
	const descriptor = descriptorOf(path, "output");

	return descriptor === undefined ? { kind: "file", path } : { kind: "stream", stream: writableOf(descriptor) };
};

const checkSampleRate = (sampleRate: number | undefined, format: StreamFormat): void => {
	if (sampleRate === undefined || sampleRate === 0) {
		return;
	}

	if (sampleRate < 0) {
		throw new Error(`Invalid sample rate: ${sampleRate}`);
	}

	if (sampleRate !== format.sampleRate) {
		throw new Error(
			`loudness-tool keeps the input's sample rate: output -ar ${sampleRate} differs from the input's ${format.sampleRate}`,
		);
	}
};

const checkCountForm = (option: string, count: number, channelMask: number): void => {
	const defaultMask = DEFAULT_LAYOUT_MASKS[count];

	if (channelMask !== 0 && defaultMask !== undefined && channelMask !== defaultMask) {
		throw new Error(
			`${CHANNELS_KEPT}: output ${option} would rematrix the input's layout ${hexOf(channelMask)} to ${count}'s default layout`,
		);
	}
};

const outputMaskOf = (stream: StreamOptions, format: StreamFormat): number => {
	const layout = stream.channelLayout;
	const { channelCount, channelMask } = format;

	if (layout !== undefined) {
		if (layout.channelCount !== channelCount) {
			throw new Error(
				`${CHANNELS_KEPT}: output -ch_layout ${layout.name} has ${layout.channelCount} channels, the input ${channelCount}`,
			);
		}

		if (layout.channelMask === 0) {
			checkCountForm(`-ch_layout ${layout.name}`, channelCount, channelMask);

			return channelMask;
		}

		if (layout.channelMask === channelMask) {
			return channelMask;
		}

		if (channelMask !== 0) {
			throw new Error(
				`${CHANNELS_KEPT}: output -ch_layout ${layout.name} differs from the input's layout ${hexOf(channelMask)}`,
			);
		}

		return layout.channelMask;
	}

	const count = stream.channelCount;

	if (count === undefined || count === 0) {
		return channelMask;
	}

	if (count < 0) {
		throw new Error(`Invalid channel count: ${count}`);
	}

	if (count !== channelCount) {
		throw new Error(`${CHANNELS_KEPT}: output -ac ${count} differs from the input's ${channelCount}`);
	}

	checkCountForm(`-ac ${count}`, count, channelMask);

	return channelMask;
};

export const resolveOutput = (
	request: OutputRequest,
	format: StreamFormat,
): { readonly output: AudioOutput; readonly format: StreamFormat } => {
	const { stream } = request;

	checkSampleRate(stream.sampleRate, format);

	const channelMask = outputMaskOf(stream, format);
	const isWav = stream.format === "wav";

	return {
		output: {
			sink: sinkOf(request.path),
			container: isWav ? "wav" : "raw",
			bitDepth: stream.format === "wav" ? wavOutputBitDepthOf(format.bitDepth) : rawBitDepthOf(stream.format),
			channelMask,
		},
		format: { ...format, channelMask },
	};
};

export const writeSummary = async (output: string, text: string): Promise<void> =>
	writeTextToStream(descriptorOf(output, "output") === 1 ? process.stderr : process.stdout, text);
