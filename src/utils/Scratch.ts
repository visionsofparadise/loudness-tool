import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class Scratch {
	static async create(baseDirectory?: string): Promise<Scratch> {
		const parent = baseDirectory ?? tmpdir();

		if (baseDirectory !== undefined) {
			await mkdir(parent, { recursive: true });
		}

		const directory = await mkdtemp(join(parent, "loudness-tool-"));

		return new Scratch(directory);
	}

	readonly directory: string;

	private disposed = false;

	private constructor(directory: string) {
		this.directory = directory;
	}

	filePath(label: string): string {
		return join(this.directory, label);
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}

		this.disposed = true;

		await rm(this.directory, { recursive: true, force: true });
	}
}
