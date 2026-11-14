import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbToLinear } from "../utils/db";
import { runCli, writeTestWav } from "../utils/testCli";
import { createSine } from "../utils/testSignals";

const SAMPLE_RATE = 48000;

interface StatsFigures {
	readonly truePeakDb: number | null;
	readonly integratedLufs: number | null;
}

const statsOf = async (path: string): Promise<StatsFigures> => {
	const run = await runCli(["stats", "--json", path]);
	const [figures] = JSON.parse(run.stdout.toString("utf8")) as Array<StatsFigures>;

	if (figures === undefined) {
		throw new Error(`stats printed no figures for ${path}`);
	}

	return figures;
};

const printedTruePeakOf = (stdout: string): number => {
	const match = /output true peak\s+(-?\d+\.\d+) dBTP/.exec(stdout);

	if (match?.[1] === undefined) {
		throw new Error(`lufs-norm printed no output true peak: ${stdout}`);
	}

	return Number(match[1]);
};

describe("lufs-norm", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-lufs-norm-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("lands on its target when the gain carries blocks across the -70 LUFS gate", async () => {
		const inputPath = join(workingDirectory, "gate.wav");
		const outputPath = join(workingDirectory, "gate-out.wav");
		const tone = createSine(3 * SAMPLE_RATE, 2, SAMPLE_RATE, 997, dbToLinear(-69.9));
		const channels = tone.map((channel) => {
			const padded = new Float64Array(5 * SAMPLE_RATE);

			padded.set(channel, SAMPLE_RATE);

			return padded;
		});

		await writeTestWav(inputPath, channels, { bitDepth: "32f" });

		const run = await runCli(["lufs-norm", inputPath, "-o", outputPath, "--lufs", "-16"]);
		const { integratedLufs } = await statsOf(outputPath);

		expect(run.exitCode).toBeUndefined();
		expect(Math.abs((integratedLufs ?? Number.NaN) + 16)).toBeLessThan(0.05);
	});

	it("prints the true peak of the clipped 16-bit file it wrote", async () => {
		const inputPath = join(workingDirectory, "sine.wav");
		const outputPath = join(workingDirectory, "sine-out.wav");

		await writeTestWav(inputPath, createSine(3 * SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-20)), {
			bitDepth: "16",
		});

		const run = await runCli(["lufs-norm", inputPath, "-o", outputPath, "--lufs", "0"]);
		const printed = printedTruePeakOf(run.stdout.toString("utf8"));
		const { truePeakDb } = await statsOf(outputPath);

		expect(Math.abs(printed - (truePeakDb ?? Number.NaN))).toBeLessThanOrEqual(0.01);
		expect(run.stderr).toBe(`warning: output true peak ${printed.toFixed(2)} dBTP exceeds 0 dBTP\n`);
	});
});
