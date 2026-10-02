import { decodeFrames } from "./utils/sampleCodec";
import { chunkWalkOf, stepChunk } from "./utils/wavFormat";
import { BLOCK_FRAMES, type AudioBlock, type BlockSource, type StreamFormat } from "./WavReader";
import type { WavSpool } from "./WavSpool";

const PREAMBLE_SIZE = 12;
const CHUNK_HEADER_SIZE = 8;

class StreamBytes {
	private readonly iterator: AsyncIterator<string | Buffer>;
	private buffered: Array<Buffer> = [];
	private bufferedLength = 0;
	private isEnded = false;

	constructor(stream: NodeJS.ReadableStream) {
		this.iterator = stream[Symbol.asyncIterator]();
	}

	async read(byteCount: number): Promise<Buffer> {
		while (this.bufferedLength < byteCount && !this.isEnded) {
			await this.pull();
		}

		return this.take(byteCount);
	}

	async readExactly(byteCount: number): Promise<Buffer> {
		const bytes = await this.read(byteCount);

		if (bytes.length < byteCount) {
			throw new Error("Invalid WAV stream: it ends inside the header");
		}

		return bytes;
	}

	async skip(byteCount: number): Promise<void> {
		let remaining = byteCount;

		while (remaining > 0) {
			if (this.bufferedLength === 0) {
				if (this.isEnded) {
					return;
				}

				await this.pull();

				continue;
			}

			remaining -= this.take(remaining).length;
		}
	}

	async drain(): Promise<void> {
		while (!this.isEnded) {
			await this.pull();
			this.take(this.bufferedLength);
		}

		this.take(this.bufferedLength);
	}

	async cancel(): Promise<void> {
		if (this.isEnded) {
			return;
		}

		this.isEnded = true;

		await this.iterator.return?.();
	}

	private async pull(): Promise<void> {
		const result = await this.iterator.next();

		if (result.done === true) {
			this.isEnded = true;

			return;
		}

		const chunk = typeof result.value === "string" ? Buffer.from(result.value) : result.value;

		if (chunk.length > 0) {
			this.buffered.push(chunk);
			this.bufferedLength += chunk.length;
		}
	}

	private take(byteCount: number): Buffer {
		const all = this.buffered.length === 1 ? this.buffered[0] : Buffer.concat(this.buffered, this.bufferedLength);

		if (all === undefined) {
			return Buffer.alloc(0);
		}

		const taken = all.subarray(0, byteCount);
		const rest = all.subarray(taken.length);

		this.buffered = rest.length > 0 ? [rest] : [];
		this.bufferedLength = rest.length;

		return taken;
	}
}

export class WavStreamReader implements BlockSource {
	static async open(
		stream: NodeJS.ReadableStream,
		spool?: (format: StreamFormat, blockAlign: number) => Promise<WavSpool>,
	): Promise<WavStreamReader> {
		const bytes = new StreamBytes(stream);

		try {
			const walk = chunkWalkOf(await bytes.readExactly(PREAMBLE_SIZE));

			if (walk === undefined) {
				throw new Error("Not a WAV stream");
			}

			for (;;) {
				const chunkHeader = await bytes.read(CHUNK_HEADER_SIZE);

				if (chunkHeader.length < CHUNK_HEADER_SIZE) {
					throw new Error("Invalid WAV stream: it ends before a data chunk");
				}

				let payloadBytesRead = 0;
				const step = await stepChunk(walk, chunkHeader, async (byteCount) => {
					payloadBytesRead = byteCount;

					return bytes.readExactly(byteCount);
				});

				if (step.kind === "data") {
					const { blockAlign, ...format } = step.formatFields;

					return new WavStreamReader(
						bytes,
						format,
						blockAlign,
						step.declaredDataSize ?? Number.POSITIVE_INFINITY,
						await spool?.(format, blockAlign),
					);
				}

				await bytes.skip(step.byteCount - payloadBytesRead);
			}
		} catch (error) {
			await bytes.cancel();

			throw error;
		}
	}

	readonly format: StreamFormat;

	private readonly bytes: StreamBytes;
	private readonly blockAlign: number;
	private readonly dataSize: number;
	private readonly spool: WavSpool | undefined;
	private isIterated = false;
	private isAtEnd = false;
	private isClosed = false;

	private constructor(
		bytes: StreamBytes,
		format: StreamFormat,
		blockAlign: number,
		dataSize: number,
		spool: WavSpool | undefined,
	) {
		this.bytes = bytes;
		this.format = format;
		this.blockAlign = blockAlign;
		this.dataSize = dataSize;
		this.spool = spool;
	}

	get hasReachedEnd(): boolean {
		return this.isAtEnd;
	}

	async *blocks(): AsyncIterableIterator<AudioBlock> {
		if (this.isIterated) {
			throw new Error("A WAV stream can be read once");
		}

		this.isIterated = true;

		const { blockAlign } = this;
		const blockBytes = BLOCK_FRAMES * blockAlign;
		let remainingBytes = this.dataSize;
		let frameIndex = 0;

		for (;;) {
			const bytes = await this.bytes.read(Math.min(blockBytes, remainingBytes));
			const frameCount = Math.floor(bytes.length / blockAlign);

			remainingBytes -= bytes.length;

			if (frameCount > 0) {
				const frameBytes = bytes.subarray(0, frameCount * blockAlign);

				await this.spool?.append(frameBytes);

				yield {
					channels: decodeFrames(frameBytes, frameCount, {
						channelCount: this.format.channelCount,
						blockAlign,
						bitDepth: this.format.bitDepth,
					}),
					frameIndex,
				};

				frameIndex += frameCount;
			}

			if (bytes.length < blockBytes) {
				break;
			}
		}

		await this.bytes.drain();

		this.isAtEnd = true;
	}

	async close(): Promise<void> {
		if (this.isClosed) {
			return;
		}

		this.isClosed = true;

		if (this.isAtEnd) {
			try {
				await this.spool?.close();
			} catch (error) {
				await this.spool?.abort();

				throw error;
			}

			return;
		}

		try {
			await this.spool?.abort();
		} finally {
			await this.bytes.cancel();
		}
	}
}
