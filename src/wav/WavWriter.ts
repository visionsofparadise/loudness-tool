import { writeToStream } from "../utils/writeToStream";
import { bytesPerSampleOf, encodeQuantizedSample, encodeSample } from "./utils/sampleCodec";
import { TemporaryFile } from "./utils/TemporaryFile";
import { wavHeaderOf } from "./utils/wavHeader";
import type { WavBitDepth } from "./utils/wavFormat";

export type WavSink =
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "stream"; readonly stream: NodeJS.WritableStream };

interface WavWriterFormat {
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly channelMask: number;
	readonly bitDepth: WavBitDepth;
	readonly frameCount: number;
}

interface WavOutput {
	write(buffer: Buffer, position: number): Promise<void>;

	commit(): Promise<void>;

	discard(): Promise<void>;
}

const streamOutputOf = (stream: NodeJS.WritableStream): WavOutput => ({
	write: async (buffer) => writeToStream(stream, buffer),
	commit: () => Promise.resolve(),
	discard: () => Promise.resolve(),
});

export const sinkOutputOf = async (sink: WavSink): Promise<WavOutput> =>
	sink.kind === "file" ? TemporaryFile.create(sink.path) : streamOutputOf(sink.stream);

export class WavWriter {
	static async create(sink: WavSink, format: WavWriterFormat): Promise<WavWriter> {
		const blockAlign = format.channelCount * bytesPerSampleOf(format.bitDepth);
		const header = wavHeaderOf({ ...format, blockAlign }, format.frameCount * blockAlign);
		const output = await sinkOutputOf(sink);

		try {
			await output.write(header, 0);
		} catch (error) {
			await output.discard();

			throw error;
		}

		return new WavWriter(output, format, blockAlign, header.length);
	}

	private readonly output: WavOutput;
	private readonly format: WavWriterFormat;
	private readonly blockAlign: number;
	private readonly dataOffset: number;
	private framesWritten = 0;

	private constructor(output: WavOutput, format: WavWriterFormat, blockAlign: number, dataOffset: number) {
		this.output = output;
		this.format = format;
		this.blockAlign = blockAlign;
		this.dataOffset = dataOffset;
	}

	async write(channels: ReadonlyArray<Float64Array>): Promise<void> {
		await this.encodeAndWrite(channels, encodeSample);
	}

	async writeQuantized(channels: ReadonlyArray<Float64Array>): Promise<void> {
		await this.encodeAndWrite(channels, encodeQuantizedSample);
	}

	private async encodeAndWrite(channels: ReadonlyArray<Float64Array>, encode: typeof encodeSample): Promise<void> {
		const { channelCount, bitDepth } = this.format;

		if (channels.length !== channelCount) {
			throw new Error(`Channel count mismatch: expected ${channelCount}, received ${channels.length}`);
		}

		const frameCount = channels[0]?.length ?? 0;
		const nextFramesWritten = this.framesWritten + frameCount;

		if (nextFramesWritten > this.format.frameCount) {
			throw new Error(
				`Frame count overrun: the header declares ${this.format.frameCount} frames, received ${nextFramesWritten}`,
			);
		}

		const buffer = Buffer.alloc(frameCount * this.blockAlign);
		let offset = 0;

		for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
			for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
				const sample = channels[channelIndex]?.[frameIndex] ?? 0;

				offset = encode(buffer, offset, sample, bitDepth);
			}
		}

		await this.output.write(buffer, this.dataOffset + this.framesWritten * this.blockAlign);

		this.framesWritten = nextFramesWritten;
	}

	async close(): Promise<void> {
		if (this.framesWritten !== this.format.frameCount) {
			await this.output.discard();

			throw new Error(
				`Frame count mismatch: the header declares ${this.format.frameCount} frames, ${this.framesWritten} were written`,
			);
		}

		await this.output.commit();
	}

	async abort(): Promise<void> {
		await this.output.discard();
	}
}
