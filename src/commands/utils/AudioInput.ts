import { open } from "node:fs/promises";
import { MeasurementOverflow } from "../../measurement/MeasurementOverflow";
import { Scratch } from "../../utils/Scratch";
import { WavSpool } from "../../wav/WavSpool";
import { WavStreamReader } from "../../wav/WavStreamReader";
import { resolveOutput, type AudioOutput, type OutputRequest } from "./sinks";
import { descriptorOf, readableOf } from "./stdioPath";
import { DEFAULT_STREAM_OPTIONS, inputFormatOf, type StreamOptions } from "./streamOptions";
import { withWavReader } from "./withWavReader";
import type { AudioBlock, BlockSource, StreamFormat } from "../../wav/WavReader";

const SPOOL_LABEL = "input.wav";

async function* finiteBlocksOf(
	blocks: AsyncIterableIterator<AudioBlock>,
	label: string,
): AsyncIterableIterator<AudioBlock> {
	for await (const block of blocks) {
		for (const [channelIndex, channel] of block.channels.entries()) {
			for (let index = 0; index < channel.length; index++) {
				if (!Number.isFinite(channel[index])) {
					throw new Error(
						`"${label}" holds a sample that is not a finite number at frame ${block.frameIndex + index}, channel ${channelIndex}`,
					);
				}
			}
		}

		yield block;
	}
}

interface AudioInputOptions {
	readonly replayable: boolean;
	readonly scratchDirectory: string | undefined;
	readonly stream: StreamOptions;
	readonly output: OutputRequest | undefined;
}

export class AudioInput {
	static async of(path: string, options: AudioInputOptions): Promise<AudioInput> {
		const descriptor = descriptorOf(path, "input");
		const isSpooled = options.replayable && (descriptor !== undefined || options.stream.format !== "wav");

		return new AudioInput(
			path,
			descriptor,
			options,
			isSpooled ? await Scratch.create(options.scratchDirectory) : undefined,
		);
	}

	readonly label: string;

	private readonly descriptor: number | undefined;
	private readonly options: AudioInputOptions;
	private readonly scratch: Scratch | undefined;
	private resolvedOutput: AudioOutput | undefined;
	private isFirstPassStarted = false;
	private isReplayable = false;

	private constructor(
		label: string,
		descriptor: number | undefined,
		options: AudioInputOptions,
		scratch: Scratch | undefined,
	) {
		this.label = label;
		this.descriptor = descriptor;
		this.options = options;
		this.scratch = scratch;
	}

	async withFirstPass<T>(consume: (source: BlockSource) => Promise<T>): Promise<T> {
		if (this.isFirstPassStarted) {
			throw new Error(`The first pass over "${this.label}" has already run`);
		}

		this.isFirstPassStarted = true;

		const { stream } = this.options;

		if (stream.format === "wav" && this.descriptor === undefined) {
			const result = await withWavReader(this.label, async (reader) =>
				consume(this.sourceOf(reader, inputFormatOf(stream, this.label, reader.format))),
			);

			this.isReplayable = true;

			return result;
		}

		const { scratch } = this;
		const spool =
			scratch === undefined
				? undefined
				: async (format: StreamFormat, blockAlign: number): Promise<WavSpool> =>
						WavSpool.create(scratch.filePath(SPOOL_LABEL), format, blockAlign);
		let reader: WavStreamReader;
		let rawFormat: StreamFormat | undefined;

		if (stream.format === "wav") {
			reader = await WavStreamReader.open(readableOf(this.descriptor ?? 0), this.label, spool);
		} else {
			const format = inputFormatOf(stream, this.label, undefined);

			rawFormat = this.resolve(format);

			const bytes =
				this.descriptor === undefined
					? (await open(this.label, "r")).createReadStream()
					: readableOf(this.descriptor);

			reader = await WavStreamReader.openRaw(bytes, format, spool);
		}

		try {
			return await consume(this.sourceOf(reader, rawFormat ?? inputFormatOf(stream, this.label, reader.format)));
		} finally {
			await reader.close();

			this.isReplayable = scratch !== undefined && reader.hasReachedEnd;
		}
	}

	output(): AudioOutput {
		if (this.resolvedOutput === undefined) {
			throw new Error(`"${this.label}" has no output before its first pass has opened it`);
		}

		return this.resolvedOutput;
	}

	replayPath(): string {
		if (!this.isReplayable) {
			throw new Error(`"${this.label}" has no replay before its first pass has read it to the end`);
		}

		return this.scratch?.filePath(SPOOL_LABEL) ?? this.label;
	}

	async dispose(): Promise<void> {
		await this.scratch?.dispose();
	}

	private resolve(format: StreamFormat): StreamFormat {
		const request = this.options.output;

		if (request === undefined || this.resolvedOutput !== undefined) {
			return format;
		}

		const resolved = resolveOutput(request, format);

		this.resolvedOutput = resolved.output;

		return resolved.format;
	}

	private sourceOf(reader: BlockSource, format: StreamFormat): BlockSource {
		const resolved = this.resolve(format);
		const isFloat = format.bitDepth === "32f" || format.bitDepth === "64f";

		return {
			format: resolved,
			blocks: () => (isFloat ? finiteBlocksOf(reader.blocks(), this.label) : reader.blocks()),
			close: async () => reader.close(),
		};
	}
}

export const replayableInputOptionsOf = (options: {
	readonly output: string;
	readonly scratchDir?: string;
	readonly inputStream?: StreamOptions;
	readonly outputStream?: StreamOptions;
}): AudioInputOptions => ({
	replayable: true,
	scratchDirectory: options.scratchDir,
	stream: options.inputStream ?? DEFAULT_STREAM_OPTIONS,
	output: { path: options.output, stream: options.outputStream ?? DEFAULT_STREAM_OPTIONS },
});

export const withAudioInput = async <T>(
	path: string,
	options: AudioInputOptions,
	consume: (input: AudioInput) => Promise<T>,
): Promise<T> => {
	const input = await AudioInput.of(path, options);

	try {
		return await consume(input);
	} catch (error: unknown) {
		if (error instanceof MeasurementOverflow) {
			throw new Error(`"${input.label}" overflows the measurement at frame ${error.frame}`, {
				cause: error,
			});
		}

		throw error;
	} finally {
		await input.dispose();
	}
};
