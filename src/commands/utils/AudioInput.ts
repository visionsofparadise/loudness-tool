import { Scratch } from "../../utils/Scratch";
import { WavSpool } from "../../wav/WavSpool";
import { WavStreamReader } from "../../wav/WavStreamReader";
import { STDIO_PATH } from "./stdioPath";
import { withWavReader } from "./withWavReader";
import type { BlockSource } from "../../wav/WavReader";
import type { Command } from "commander";

const SPOOL_LABEL = "input.wav";

interface AudioInputOptions {
	readonly replayable: boolean;
	readonly scratchDirectory: string | undefined;
}

export class AudioInput {
	static async of(path: string, options: AudioInputOptions): Promise<AudioInput> {
		if (path !== STDIO_PATH || !options.replayable) {
			return new AudioInput(path, undefined);
		}

		return new AudioInput(path, await Scratch.create(options.scratchDirectory));
	}

	readonly label: string;

	private readonly scratch: Scratch | undefined;
	private isFirstPassStarted = false;
	private isReplayable = false;

	private constructor(label: string, scratch: Scratch | undefined) {
		this.label = label;
		this.scratch = scratch;
	}

	async withFirstPass<T>(consume: (source: BlockSource) => Promise<T>): Promise<T> {
		if (this.isFirstPassStarted) {
			throw new Error(`The first pass over "${this.label}" has already run`);
		}

		this.isFirstPassStarted = true;

		if (this.label !== STDIO_PATH) {
			const result = await withWavReader(this.label, consume);

			this.isReplayable = true;

			return result;
		}

		const { scratch } = this;
		const reader = await WavStreamReader.open(
			process.stdin,
			this.label,
			scratch === undefined
				? undefined
				: async (format, blockAlign) => WavSpool.create(scratch.filePath(SPOOL_LABEL), format, blockAlign),
		);

		try {
			return await consume(reader);
		} finally {
			await reader.close();

			this.isReplayable = scratch !== undefined && reader.hasReachedEnd;
		}
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
}

export const withAudioInput = async <T>(
	path: string,
	options: AudioInputOptions,
	consume: (input: AudioInput) => Promise<T>,
): Promise<T> => {
	const input = await AudioInput.of(path, options);

	try {
		return await consume(input);
	} finally {
		await input.dispose();
	}
};

export const scratchDirectoryOf = (command: Command): string | undefined =>
	command.optsWithGlobals<{ readonly scratchDir?: string }>().scratchDir;
