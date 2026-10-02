import { TemporaryFile } from "./utils/TemporaryFile";
import { spoolHeaderOf, type WavHeaderFormat } from "./utils/wavHeader";
import type { StreamFormat } from "./WavReader";

export class WavSpool {
	static async create(path: string, format: StreamFormat, blockAlign: number): Promise<WavSpool> {
		const headerFormat: WavHeaderFormat = {
			sampleRate: format.sampleRate,
			channelCount: format.channelCount,
			channelMask: format.channelMask,
			bitDepth: format.bitDepth,
			blockAlign,
		};
		const header = spoolHeaderOf(headerFormat, 0);
		const file = await TemporaryFile.create(path);

		try {
			await file.write(header, 0);
		} catch (error) {
			await file.discard();

			throw error;
		}

		return new WavSpool(file, headerFormat, header.length);
	}

	private readonly file: TemporaryFile;
	private readonly format: WavHeaderFormat;
	private readonly dataOffset: number;
	private dataSize = 0;
	private isClosed = false;

	private constructor(file: TemporaryFile, format: WavHeaderFormat, dataOffset: number) {
		this.file = file;
		this.format = format;
		this.dataOffset = dataOffset;
	}

	async append(bytes: Buffer): Promise<void> {
		await this.file.write(bytes, this.dataOffset + this.dataSize);

		this.dataSize += bytes.length;
	}

	async close(): Promise<void> {
		if (this.isClosed) {
			return;
		}

		await this.file.write(spoolHeaderOf(this.format, this.dataSize), 0);

		this.isClosed = true;

		await this.file.commit();
	}

	async abort(): Promise<void> {
		this.isClosed = true;

		await this.file.discard();
	}
}
