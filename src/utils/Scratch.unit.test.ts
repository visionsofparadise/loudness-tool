import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scratch } from "./Scratch";

const scratchDirectories: Array<string> = [];

afterEach(async () => {
	vi.restoreAllMocks();

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
	it("creates a unique directory under the node temp folder", async () => {
		const scratch = await Scratch.create();

		scratchDirectories.push(scratch.directory);

		expect(existsSync(scratch.directory)).toBe(true);
		expect(dirname(scratch.directory)).toBe(tmpdir());
		expect(basename(scratch.directory)).toMatch(new RegExp(`^loudness-tool-${process.pid}-`));

		await scratch.dispose();
	});

	it("creates the directory under an overridden base as the root", async () => {
		const baseDirectory = join(tmpdir(), `loudness-tool-scratch-base-${Date.now()}`);

		scratchDirectories.push(baseDirectory);

		await mkdir(baseDirectory, { recursive: true });

		const scratch = await Scratch.create(baseDirectory);

		expect(dirname(scratch.directory)).toBe(baseDirectory);
		expect(basename(scratch.directory)).toMatch(new RegExp(`^loudness-tool-${process.pid}-`));

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

		const deadDirectory = join(rootDirectory, `loudness-tool-${absentProcessIdOf()}-stale`);
		const liveDirectory = join(rootDirectory, `loudness-tool-${process.pid}-keep`);

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

	it("leaves a non-matching sibling in a user-supplied root", async () => {
		const rootDirectory = join(tmpdir(), `loudness-tool-scratch-unrelated-${Date.now()}`);

		scratchDirectories.push(rootDirectory);

		await mkdir(rootDirectory, { recursive: true });

		const unrelatedDirectory = join(rootDirectory, "scratch-4242-backup");

		await mkdir(unrelatedDirectory);
		await writeFile(join(unrelatedDirectory, "keep-me.bin"), "payload");

		const scratch = await Scratch.create(rootDirectory);

		expect(existsSync(unrelatedDirectory)).toBe(true);
		expect(existsSync(join(unrelatedDirectory, "keep-me.bin"))).toBe(true);

		await scratch.dispose();

		expect(existsSync(unrelatedDirectory)).toBe(true);
	});

	it("retains a matching directory when the PID probe throws EPERM", async () => {
		const rootDirectory = join(tmpdir(), `loudness-tool-scratch-eperm-${Date.now()}`);

		scratchDirectories.push(rootDirectory);

		await mkdir(rootDirectory, { recursive: true });

		const uncertainProcessId = 4242;
		const uncertainDirectory = join(rootDirectory, `loudness-tool-${uncertainProcessId}-uncertain`);

		await mkdir(uncertainDirectory);
		await writeFile(join(uncertainDirectory, "payload.bin"), "payload");

		const originalKill = process.kill.bind(process);

		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === uncertainProcessId) {
				throw Object.assign(new Error("denied"), { code: "EPERM" });
			}

			return originalKill(pid, signal);
		});

		const scratch = await Scratch.create(rootDirectory);

		expect(existsSync(uncertainDirectory)).toBe(true);

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
