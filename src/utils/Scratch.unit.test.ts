import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Scratch } from "./Scratch";

const scratchDirectories: Array<string> = [];

afterEach(async () => {
	for (const directory of scratchDirectories) {
		await rm(directory, { recursive: true, force: true });
	}

	scratchDirectories.length = 0;
});

const absentProcessIdOf = (): number => {
	for (let processId = 1; processId < 1_000_000; processId++) {
		if (processId === process.pid) {
			continue;
		}

		try {
			process.kill(processId, 0);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
				return processId;
			}
		}
	}

	throw new Error("no absent process id");
};

describe("Scratch", () => {
	it("creates a unique directory under the default namespaced root", async () => {
		const scratch = await Scratch.create();

		scratchDirectories.push(scratch.directory);

		expect(existsSync(scratch.directory)).toBe(true);
		expect(dirname(scratch.directory)).toBe(join(tmpdir(), "loudness-tool"));
		expect(basename(scratch.directory)).toMatch(new RegExp(`^scratch-${process.pid}-`));

		await scratch.dispose();
	});

	it("creates the directory under an overridden base as the root", async () => {
		const baseDirectory = join(tmpdir(), `loudness-tool-scratch-base-${Date.now()}`);

		scratchDirectories.push(baseDirectory);

		await mkdir(baseDirectory, { recursive: true });

		const scratch = await Scratch.create(baseDirectory);

		expect(dirname(scratch.directory)).toBe(baseDirectory);
		expect(basename(scratch.directory)).toMatch(new RegExp(`^scratch-${process.pid}-`));

		await scratch.dispose();
		expect(existsSync(scratch.directory)).toBe(false);
		expect(await readdir(baseDirectory)).toEqual([]);
	});

	it("creates a missing base directory", async () => {
		const baseDirectory = join(tmpdir(), `loudness-tool-scratch-missing-${Date.now()}`);

		scratchDirectories.push(baseDirectory);

		const scratch = await Scratch.create(baseDirectory);

		expect(existsSync(scratch.directory)).toBe(true);

		await scratch.dispose();
	});

	it("scavenges a dead-PID sibling and keeps a live-PID sibling", async () => {
		const rootDirectory = join(tmpdir(), `loudness-tool-scratch-scavenge-${Date.now()}`);

		scratchDirectories.push(rootDirectory);

		await mkdir(rootDirectory, { recursive: true });

		const deadDirectory = join(rootDirectory, `scratch-${absentProcessIdOf()}-stale`);
		const liveDirectory = join(rootDirectory, `scratch-${process.pid}-keep`);

		await mkdir(deadDirectory);
		await mkdir(liveDirectory);
		await writeFile(join(deadDirectory, "abandoned.bin"), "payload");

		const scratch = await Scratch.create(rootDirectory);

		expect(existsSync(deadDirectory)).toBe(false);
		expect(existsSync(liveDirectory)).toBe(true);
		expect(dirname(scratch.directory)).toBe(rootDirectory);

		await scratch.dispose();

		expect(existsSync(scratch.directory)).toBe(false);
		expect(existsSync(liveDirectory)).toBe(true);
	});

	it("joins labels onto the directory", async () => {
		const scratch = await Scratch.create();

		scratchDirectories.push(scratch.directory);

		expect(scratch.filePath("detection")).toBe(join(scratch.directory, "detection"));

		await scratch.dispose();
	});

	it("dispose removes the directory and everything in it", async () => {
		const scratch = await Scratch.create();
		const nested = scratch.filePath("nested.bin");

		scratchDirectories.push(scratch.directory);

		await writeFile(nested, "payload");

		expect(existsSync(nested)).toBe(true);

		await scratch.dispose();

		expect(existsSync(scratch.directory)).toBe(false);
		expect(existsSync(nested)).toBe(false);
	});

	it("dispose is idempotent", async () => {
		const scratch = await Scratch.create();

		scratchDirectories.push(scratch.directory);

		await scratch.dispose();
		await scratch.dispose();

		expect(existsSync(scratch.directory)).toBe(false);
	});
});
