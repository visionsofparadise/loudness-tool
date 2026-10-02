import { open, type FileHandle } from "node:fs/promises";
import { bytesPerSampleOf, decodeSample } from "./utils/sampleCodec";
import { parseWavFormat, type ParsedWavFormat, type SourceBitDepth } from "./utils/wavFormat";

export const BLOCK_FRAMES = 65536;

export interface StreamFormat {
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly channelMask: number;
	readonly bitDepth: SourceBitDepth;
}

export interface AudioFormat extends StreamFormat {
	readonly frameCount: number;
}

export interface AudioBlock {
	readonly channels: ReadonlyArray<Float64Array>;
	readonly frameIndex: number;
}

export interface BlockSource {
	readonly format: StreamFormat;
	blocks(): AsyncIterableIterator<AudioBlock>;

	close(): Promise<void>;
}

export class WavReader implements BlockSource {
	static async open(path: string): Promise<WavReader> {
		const fileHandle = await open(path, "r");

		try {
			const parsed = await parseWavFormat(fileHandle, path);

			return new WavReader(fileHandle, parsed);
		} catch (error) {
			await fileHandle.close();

			throw error;
		}
	}

	readonly format: AudioFormat;

	private readonly fileHandle: FileHandle;
	private readonly dataOffset: number;
	private readonly blockAlign: number;
	private readonly bitDepth: SourceBitDepth;
	private isClosed = false;

	private constructor(fileHandle: FileHandle, parsed: ParsedWavFormat) {
		this.fileHandle = fileHandle;
		this.dataOffset = parsed.dataOffset;
		this.blockAlign = parsed.blockAlign;
		this.bitDepth = parsed.bitDepth;
		this.format = {
			sampleRate: parsed.sampleRate,
			channelCount: parsed.channelCount,
			channelMask: parsed.channelMask,
			bitDepth: parsed.bitDepth,
			frameCount: Math.floor(parsed.dataSize / parsed.blockAlign),
		};
	}

	async *blocks(): AsyncIterableIterator<AudioBlock> {
		let frameIndex = 0;
		const { frameCount } = this.format;

		while (frameIndex < frameCount) {
			const blockFrameCount = Math.min(BLOCK_FRAMES, frameCount - frameIndex);
			const channels = await this.readBlock(frameIndex, blockFrameCount);
			const framesRead = channels[0]?.length ?? 0;

			if (framesRead === 0) {
				break;
			}

			yield { channels, frameIndex };

			frameIndex += framesRead;
		}
	}

	async close(): Promise<void> {
		if (this.isClosed) {
			return;
		}

		this.isClosed = true;

		await this.fileHandle.close();
	}

	private async readBlock(frameIndex: number, frameCount: number): Promise<Array<Float64Array>> {
		const { channelCount } = this.format;
		const bytesPerSample = bytesPerSampleOf(this.bitDepth);
		const byteCount = frameCount * this.blockAlign;
		const fileOffset = this.dataOffset + frameIndex * this.blockAlign;
		const buffer = Buffer.alloc(byteCount);
		const { bytesRead } = await this.fileHandle.read(buffer, 0, byteCount, fileOffset);
		const framesRead = Math.floor(bytesRead / this.blockAlign);
		const channels: Array<Float64Array> = [];

		for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
			const channel = new Float64Array(framesRead);

			for (let decodedFrameIndex = 0; decodedFrameIndex < framesRead; decodedFrameIndex++) {
				const sampleOffset = decodedFrameIndex * this.blockAlign + channelIndex * bytesPerSample;

				channel[decodedFrameIndex] = decodeSample(buffer, sampleOffset, this.bitDepth);
			}

			channels.push(channel);
		}

		return channels;
	}
}
