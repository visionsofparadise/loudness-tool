import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, writeTestWav } from "../utils/testCli";
import { createSine } from "../utils/testSignals";

const SAMPLE_RATE = 48000;

describe("stats on a finite sample whose square overflows", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-stats-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("fails naming the input and the frame whose loudness overflows", async () => {
		const path = join(workingDirectory, "huge.wav");
		const channels = createSine(6 * SAMPLE_RATE, 1, SAMPLE_RATE, 997, 0.1);

		channels[0]?.set([1e200], 3 * SAMPLE_RATE);
		await writeTestWav(path, channels, { bitDepth: "64f" });

		const run = await runCli(["stats", "--json", path]);

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toBe(`error: "${path}" overflows the measurement at frame ${3 * SAMPLE_RATE}
`);
		expect(JSON.parse(run.stdout.toString("utf8"))).toEqual([]);
	});
});
