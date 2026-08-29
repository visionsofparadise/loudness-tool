import { WavReader } from "../../wav/WavReader";

interface BlockConsumer {
	push(channels: ReadonlyArray<Float64Array>, frameCount: number): void;
}

export const withWavReader = async <T>(path: string, consume: (reader: WavReader) => Promise<T>): Promise<T> => {
	const reader = await WavReader.open(path);

	try {
		return await consume(reader);
	} finally {
		await reader.close();
	}
};

export const pushWavBlocks = async (reader: WavReader, consumers: ReadonlyArray<BlockConsumer>): Promise<void> => {
	for await (const block of reader.blocks()) {
		const frameCount = block.channels[0]?.length ?? 0;

		for (const consumer of consumers) {
			consumer.push(block.channels, frameCount);
		}
	}
};
