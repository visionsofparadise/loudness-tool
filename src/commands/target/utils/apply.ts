import { WavReader } from "../../../wav/WavReader";
import type { SampleFile } from "../../../utils/SampleFile";

const applyEnvelopeToChannels = (
	channels: ReadonlyArray<Float64Array>,
	envelope: Float64Array,
	frameCount: number,
): void => {
	if (envelope.length < frameCount) {
		throw new Error(
			`applyEnvelopeToChannels: envelope length (${envelope.length}) is shorter than frame count (${frameCount})`,
		);
	}

	for (const channel of channels) {
		for (let index = 0; index < frameCount; index++) {
			channel[index] = (channel[index] ?? 0) * (envelope[index] ?? 0);
		}
	}
};

export interface SampleCursor {
	iterator: AsyncIterator<Float64Array>;
	current: Float64Array | undefined;
	offset: number;
}

export const createSampleCursor = (blocks: AsyncIterable<Float64Array>): SampleCursor => ({
	iterator: blocks[Symbol.asyncIterator](),
	current: undefined,
	offset: 0,
});

export const pullSamples = async (cursor: SampleCursor, count: number): Promise<Float64Array> => {
	const output = new Float64Array(count);
	let filled = 0;

	while (filled < count) {
		if (cursor.current === undefined || cursor.offset >= cursor.current.length) {
			const next = await cursor.iterator.next();

			if (next.done) {
				throw new Error(`envelope ended after ${filled} of ${count} samples`);
			}

			cursor.current = next.value;
			cursor.offset = 0;
		}

		const available = cursor.current.length - cursor.offset;
		const take = Math.min(available, count - filled);

		output.set(cursor.current.subarray(cursor.offset, cursor.offset + take), filled);
		filled += take;
		cursor.offset += take;
	}

	return output;
};

export const forEachEnvelopedBlock = async (
	inputPath: string,
	envelope: SampleFile,
	consume: (channels: ReadonlyArray<Float64Array>, frameCount: number) => Promise<void> | void,
): Promise<void> => {
	const reader = await WavReader.open(inputPath);
	const envelopeCursor = createSampleCursor(envelope.blocks());

	try {
		for await (const block of reader.blocks()) {
			const frameCount = block.channels[0]?.length ?? 0;

			if (frameCount === 0) {
				break;
			}

			const gain = await pullSamples(envelopeCursor, frameCount);

			applyEnvelopeToChannels(block.channels, gain, frameCount);
			await consume(block.channels, frameCount);
		}
	} finally {
		await reader.close();
	}
};
