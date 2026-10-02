import { randomBytes } from "node:crypto";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";

export class TemporaryFile {
	static async create(path: string): Promise<TemporaryFile> {
		const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
		const fileHandle = await open(temporaryPath, "w");

		return new TemporaryFile(path, temporaryPath, fileHandle);
	}

	private readonly destinationPath: string;
	private readonly temporaryPath: string;
	private readonly fileHandle: FileHandle;
	private isSettled = false;

	private constructor(destinationPath: string, temporaryPath: string, fileHandle: FileHandle) {
		this.destinationPath = destinationPath;
		this.temporaryPath = temporaryPath;
		this.fileHandle = fileHandle;
	}

	async write(buffer: Buffer, position: number): Promise<void> {
		await this.fileHandle.write(buffer, 0, buffer.length, position);
	}

	async commit(): Promise<void> {
		if (this.isSettled) {
			return;
		}

		await this.fileHandle.close();

		this.isSettled = true;

		try {
			await rename(this.temporaryPath, this.destinationPath);
		} catch (error) {
			await unlink(this.temporaryPath).catch(() => undefined);

			throw new Error(`Failed to replace "${this.destinationPath}" with "${this.temporaryPath}"`, {
				cause: error,
			});
		}
	}

	async discard(): Promise<void> {
		if (this.isSettled) {
			return;
		}

		this.isSettled = true;

		await this.fileHandle.close().catch(() => undefined);
		await unlink(this.temporaryPath).catch(() => undefined);
	}
}
