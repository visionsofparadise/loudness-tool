import { randomBytes } from "node:crypto";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { bytesPerSampleOf, encodeSample } from "./utils/sampleCodec";
import { assertRiffDataSize, type WavBitDepth } from "./utils/wavFormat";

const WAV_HEADER_SIZE = 44;

const buildWavHeader = (dataSize: number, sampleRate: number, channelCount: number, bitDepth: WavBitDepth): Buffer => {
	const header = Buffer.alloc(WAV_HEADER_SIZE);
	const bytesPerSample = bytesPerSampleOf(bitDepth);
	const blockAlign = channelCount * bytesPerSample;
	const byteRate = sampleRate * blockAlign;
	const bitsPerSample = bytesPerSample * 8;
	const audioFormat = bitDepth === "32f" ? 3 : 1;

	header.write("RIFF", 0);
	header.writeUInt32LE(WAV_HEADER_SIZE - 8 + dataSize + (dataSize % 2), 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(audioFormat, 20);
	header.writeUInt16LE(channelCount, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataSize, 40);

	return header;
};

export class WavWriter {
	static async create(
		path: string,
		format: { sampleRate: number; channelCount: number; bitDepth: WavBitDepth },
	): Promise<WavWriter> {
		const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
		const fileHandle = await open(temporaryPath, "w");
		const header = buildWavHeader(0, format.sampleRate, format.channelCount, format.bitDepth);

		try {
			await fileHandle.write(header, 0, header.length, 0);

			return new WavWriter(path, temporaryPath, fileHandle, format);
		} catch (error) {
			await fileHandle.close();
			await unlink(temporaryPath).catch(() => undefined);

			throw error;
		}
	}

	private readonly destinationPath: string;
	private readonly temporaryPath: string;
	private readonly fileHandle: FileHandle;
	private readonly sampleRate: number;
	private readonly channelCount: number;
	private readonly bitDepth: WavBitDepth;
	private dataSize = 0;
	private isSettled = false;

	private constructor(
		destinationPath: string,
		temporaryPath: string,
		fileHandle: FileHandle,
		format: { sampleRate: number; channelCount: number; bitDepth: WavBitDepth },
	) {
		this.destinationPath = destinationPath;
		this.temporaryPath = temporaryPath;
		this.fileHandle = fileHandle;
		this.sampleRate = format.sampleRate;
		this.channelCount = format.channelCount;
		this.bitDepth = format.bitDepth;
	}

	async write(channels: ReadonlyArray<Float64Array>): Promise<void> {
		if (channels.length !== this.channelCount) {
			throw new Error(`Channel count mismatch: expected ${this.channelCount}, received ${channels.length}`);
		}

		const frameCount = channels[0]?.length ?? 0;
		const bytesPerSample = bytesPerSampleOf(this.bitDepth);
		const blockAlign = this.channelCount * bytesPerSample;
		const buffer = Buffer.alloc(frameCount * blockAlign);
		let offset = 0;

		for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
			for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex++) {
				const sample = channels[channelIndex]?.[frameIndex] ?? 0;

				offset = encodeSample(buffer, offset, sample, this.bitDepth);
			}
		}

		const nextDataSize = this.dataSize + buffer.length;

		assertRiffDataSize(nextDataSize);

		await this.fileHandle.write(buffer, 0, buffer.length, WAV_HEADER_SIZE + this.dataSize);

		this.dataSize = nextDataSize;
	}

	async close(): Promise<void> {
		if (this.isSettled) {
			return;
		}

		if (this.dataSize % 2 === 1) {
			await this.fileHandle.write(Buffer.alloc(1), 0, 1, WAV_HEADER_SIZE + this.dataSize);
		}

		const header = buildWavHeader(this.dataSize, this.sampleRate, this.channelCount, this.bitDepth);

		await this.fileHandle.write(header, 0, header.length, 0);
		await this.fileHandle.close();

		try {
			await rename(this.temporaryPath, this.destinationPath);
		} catch (error) {
			await unlink(this.temporaryPath).catch(() => undefined);

			throw new Error(`Failed to replace "${this.destinationPath}" with "${this.temporaryPath}"`, {
				cause: error,
			});
		} finally {
			this.isSettled = true;
		}
	}

	async abort(): Promise<void> {
		if (this.isSettled) {
			return;
		}

		this.isSettled = true;

		await this.fileHandle.close().catch(() => undefined);
		await unlink(this.temporaryPath).catch(() => undefined);
	}
}
