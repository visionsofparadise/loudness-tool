import { open, unlink, type FileHandle } from "node:fs/promises";
import type { Scratch } from "./Scratch";

const SAMPLE_FILE_BLOCK_FRAMES = 65536;
const BYTES_PER_SAMPLE = 8;

const LABEL_PATTERN = /^[A-Za-z0-9-]+$/;

export class SampleFile {
	static async create(scratch: Scratch, label: string): Promise<SampleFile> {
		if (!LABEL_PATTERN.test(label)) {
			throw new Error(`SampleFile: label "${label}" must match /^[A-Za-z0-9-]+$/`);
		}

		scratch.claimLabel(label);

		try {
			const path = scratch.filePath(label);
			const fileHandle = await open(path, "w+");

			return new SampleFile(scratch, label, path, fileHandle);
		} catch (error) {
			scratch.releaseLabel(label);

			throw error;
		}
	}

	private readonly scratch: Scratch;
	private readonly label: string;
	private readonly path: string;
	private readonly fileHandle: FileHandle;
	private writtenFrames = 0;
	private isClosed = false;

	private constructor(scratch: Scratch, label: string, path: string, fileHandle: FileHandle) {
		this.scratch = scratch;
		this.label = label;
		this.path = path;
		this.fileHandle = fileHandle;
	}

	get frameCount(): number {
		return this.writtenFrames;
	}

	async append(samples: Float64Array, count: number): Promise<void> {
		this.assertOpen();

		if (count < 0) {
			throw new Error(`SampleFile: count must be non-negative, got ${count}`);
		}

		if (samples.length < count) {
			throw new Error(`SampleFile: samples has ${samples.length} values, fewer than the requested ${count}`);
		}

		if (count === 0) {
			return;
		}

		const view = samples.length === count ? samples : samples.subarray(0, count);
		const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);

		await this.fileHandle.write(bytes, 0, bytes.length, this.writtenFrames * BYTES_PER_SAMPLE);

		this.writtenFrames += count;
	}

	async *blocks(): AsyncIterableIterator<Float64Array> {
		this.assertOpen();

		let frameIndex = 0;

		while (frameIndex < this.writtenFrames) {
			const count = Math.min(SAMPLE_FILE_BLOCK_FRAMES, this.writtenFrames - frameIndex);

			yield await this.readFrames(frameIndex, count);

			frameIndex += count;
		}
	}

	async *reverseBlocks(): AsyncIterableIterator<Float64Array> {
		this.assertOpen();

		const fullBlocks = Math.floor(this.writtenFrames / SAMPLE_FILE_BLOCK_FRAMES);
		const remainder = this.writtenFrames % SAMPLE_FILE_BLOCK_FRAMES;

		if (remainder > 0) {
			const chunk = await this.readFrames(fullBlocks * SAMPLE_FILE_BLOCK_FRAMES, remainder);

			chunk.reverse();

			yield chunk;
		}

		for (let blockIndex = fullBlocks - 1; blockIndex >= 0; blockIndex--) {
			const chunk = await this.readFrames(blockIndex * SAMPLE_FILE_BLOCK_FRAMES, SAMPLE_FILE_BLOCK_FRAMES);

			chunk.reverse();

			yield chunk;
		}
	}

	async close(): Promise<void> {
		if (this.isClosed) {
			return;
		}

		this.isClosed = true;

		await this.fileHandle.close();
		await unlink(this.path).catch(() => undefined);
		this.scratch.releaseLabel(this.label);
	}

	private assertOpen(): void {
		if (this.isClosed) {
			throw new Error("SampleFile: operation after close");
		}
	}

	private async readFrames(start: number, count: number): Promise<Float64Array> {
		const samples = new Float64Array(count);
		const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
		const { bytesRead } = await this.fileHandle.read(bytes, 0, bytes.length, start * BYTES_PER_SAMPLE);
		const framesRead = Math.floor(bytesRead / BYTES_PER_SAMPLE);

		if (framesRead !== count) {
			return samples.subarray(0, framesRead);
		}

		return samples;
	}
}
