import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Scratch } from "./Scratch";

const scratchDirectories: Array<string> = [];

afterEach(async () => {
	for (const directory of scratchDirectories) {
		await rm(directory, { recursive: true, force: true });
	}

	scratchDirectories.length = 0;
});

describe("Scratch", () => {
	it("creates a unique directory under the default temp root", async () => {
		const scratch = await Scratch.create();

		scratchDirectories.push(scratch.directory);

		expect(existsSync(scratch.directory)).toBe(true);
		expect(basename(scratch.directory).startsWith("loudness-tool-")).toBe(true);
		expect(scratch.directory.startsWith(tmpdir())).toBe(true);

		await scratch.dispose();
	});

	it("creates the directory under an overridden base", async () => {
		const baseDirectory = join(tmpdir(), `loudness-tool-scratch-base-${Date.now()}`);

		scratchDirectories.push(baseDirectory);

		await mkdir(baseDirectory, { recursive: true });

		const scratch = await Scratch.create(baseDirectory);

		expect(scratch.directory.startsWith(baseDirectory)).toBe(true);
		expect(basename(scratch.directory).startsWith("loudness-tool-")).toBe(true);

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
