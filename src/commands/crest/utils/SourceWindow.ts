import { WavReader, type AudioBlock, type AudioFormat } from "../../../wav/WavReader";

export class SourceWindow {
	static async open(path: string, capacityFrames: number): Promise<SourceWindow> {
		const reader = await WavReader.open(path);

		return new SourceWindow(reader, capacityFrames);
	}

	readonly format: AudioFormat;
	readonly channels: ReadonlyArray<Float64Array>;

	private readonly reader: WavReader;
	private readonly blocks: AsyncIterator<AudioBlock>;
	private pending: AudioBlock | undefined;
	private pendingOffset = 0;
	private readFrames = 0;
	private windowFirst = 0;
	private windowCount = 0;

	private constructor(reader: WavReader, capacityFrames: number) {
		const channels: Array<Float64Array> = [];

		for (let channelIndex = 0; channelIndex < reader.format.channelCount; channelIndex++) {
			channels.push(new Float64Array(capacityFrames));
		}

		this.reader = reader;
		this.blocks = reader.blocks();
		this.format = reader.format;
		this.channels = channels;
	}

	get firstFrame(): number {
		return this.windowFirst;
	}

	async cover(firstFrame: number, frameCount: number): Promise<void> {
		const previousFirst = this.windowFirst;
		const previousEnd = previousFirst + this.windowCount;
		const keepFirst = Math.max(firstFrame, previousFirst);
		const keepEnd = Math.min(firstFrame + frameCount, previousEnd);

		for (const channel of this.channels) {
			if (keepEnd > keepFirst) {
				channel.copyWithin(keepFirst - firstFrame, keepFirst - previousFirst, keepEnd - previousFirst);
				channel.fill(0, 0, keepFirst - firstFrame);
				channel.fill(0, keepEnd - firstFrame, frameCount);
			} else {
				channel.fill(0, 0, frameCount);
			}
		}

		this.windowFirst = firstFrame;
		this.windowCount = frameCount;

		const fillFirst = Math.max(keepEnd > keepFirst ? keepEnd : firstFrame, 0);

		await this.fill(fillFirst, Math.min(firstFrame + frameCount, this.format.frameCount));
	}

	async close(): Promise<void> {
		await this.reader.close();
	}

	private async fill(firstFrame: number, endFrame: number): Promise<void> {
		while (this.readFrames < endFrame) {
			const block = await this.nextBlock();

			if (block === undefined) {
				return;
			}

			const blockFrames = block.channels[0]?.length ?? 0;
			const limit = this.readFrames < firstFrame ? Math.min(firstFrame, endFrame) : endFrame;
			const take = Math.min(blockFrames - this.pendingOffset, limit - this.readFrames);

			if (take <= 0) {
				return;
			}

			if (this.readFrames >= firstFrame) {
				this.copyFrames(block, take);
			}

			this.pendingOffset += take;
			this.readFrames += take;

			if (this.pendingOffset >= blockFrames) {
				this.pending = undefined;
				this.pendingOffset = 0;
			}
		}
	}

	private copyFrames(block: AudioBlock, frameCount: number): void {
		const windowOffset = this.readFrames - this.windowFirst;

		for (let channelIndex = 0; channelIndex < this.channels.length; channelIndex++) {
			const source = block.channels[channelIndex];

			if (source === undefined) {
				continue;
			}

			this.channels[channelIndex]?.set(
				source.subarray(this.pendingOffset, this.pendingOffset + frameCount),
				windowOffset,
			);
		}
	}

	private async nextBlock(): Promise<AudioBlock | undefined> {
		if (this.pending !== undefined) {
			return this.pending;
		}

		const next = await this.blocks.next();

		if (next.done === true) {
			return undefined;
		}

		this.pending = next.value;
		this.pendingOffset = 0;

		return this.pending;
	}
}
