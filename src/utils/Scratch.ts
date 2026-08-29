import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultRootDirectory = join(tmpdir(), "loudness-tool");

function processIsAbsent(processId: number): boolean {
	try {
		process.kill(processId, 0);

		return false;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
	}
}

async function scavengeDeadScratchDirectories(rootDirectory: string): Promise<void> {
	let entries;

	try {
		entries = await readdir(rootDirectory, { withFileTypes: true });
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return;
		}

		throw error;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const match = /^scratch-(\d+)-.+$/.exec(entry.name);

		if (match === null) {
			continue;
		}

		try {
			if (!processIsAbsent(Number(match[1]))) {
				continue;
			}

			await rm(join(rootDirectory, entry.name), { recursive: true, force: true });
		} catch {
			continue;
		}
	}
}

export class Scratch {
	static async create(baseDirectory?: string): Promise<Scratch> {
		const rootDirectory = baseDirectory ?? defaultRootDirectory;

		await mkdir(rootDirectory, { recursive: true });
		await scavengeDeadScratchDirectories(rootDirectory);

		const directory = await mkdtemp(join(rootDirectory, `scratch-${process.pid}-`));

		return new Scratch(directory);
	}

	readonly directory: string;

	private readonly liveLabels = new Set<string>();
	private disposed = false;

	private constructor(directory: string) {
		this.directory = directory;
	}

	filePath(label: string): string {
		return join(this.directory, label);
	}

	claimLabel(label: string): void {
		if (this.liveLabels.has(label)) {
			throw new Error(`Scratch: label "${label}" is already live`);
		}

		this.liveLabels.add(label);
	}

	releaseLabel(label: string): void {
		this.liveLabels.delete(label);
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}

		this.disposed = true;

		await rm(this.directory, { recursive: true, force: true });
	}
}
