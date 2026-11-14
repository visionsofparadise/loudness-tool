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

	it("reads integrated loudness and loudness range as unmeasurable and the true peak as its level", async () => {
		const path = join(workingDirectory, "huge.wav");
		const channels = createSine(6 * SAMPLE_RATE, 1, SAMPLE_RATE, 997, 0.1);

		channels[0]?.set([1e200], 3 * SAMPLE_RATE);
		await writeTestWav(path, channels, { bitDepth: "64f" });

		const json = await runCli(["stats", "--json", path]);
		const text = await runCli(["stats", path]);

		expect(JSON.parse(json.stdout.toString("utf8"))).toMatchObject([
			{ truePeakDb: 4000, integratedLufs: null, loudnessRange: null },
		]);
		expect(text.stdout.toString("utf8")).toContain(
			"true peak         4000.00 dBTP\nintegrated        n/a\nloudness range    n/a\n",
		);
	});
});
