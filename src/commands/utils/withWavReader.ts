import { WavReader, type BlockSource } from "../../wav/WavReader";

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

export const pushWavBlocks = async (source: BlockSource, consumers: ReadonlyArray<BlockConsumer>): Promise<number> => {
	let framesPushed = 0;

	for await (const block of source.blocks()) {
		const frameCount = block.channels[0]?.length ?? 0;

		for (const consumer of consumers) {
			consumer.push(block.channels, frameCount);
		}

		framesPushed += frameCount;
	}

	return framesPushed;
};
