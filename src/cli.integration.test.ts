import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSine } from "./utils/testSignals";
import { printedFigureOf, runCli, writeTestWav } from "./utils/testCli";

describe("target's action errors", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-cli-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it.each([
		[[], "at least one of --lufs and --tp is required"],
		[["--lufs", "-16", "--floor", "-30", "--pivot", "-30"], "floor must be < pivot when both are supplied"],
	])("prints the reason and exits 1 for %j", async (options, message) => {
		const inputPath = join(workingDirectory, "sine.wav");
		const outputPath = join(workingDirectory, "out.wav");

		await writeTestWav(inputPath, createSine(4800, 1, 48000, 997, 0.1), { bitDepth: "16" });

		const run = await runCli(["target", inputPath, "-o", outputPath, ...options]);

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toBe(`error: ${message}\n`);
		expect(run.stdout.length).toBe(0);
		expect(existsSync(outputPath)).toBe(false);
	});
});

describe("an input that overflows the measurement", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-cli-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it.each([[["stats"]], [["tp-norm"]], [["lufs-norm"]], [["target", "--lufs", "-16", "--tp", "-1"]], [["crest"]]])(
		"fails %j naming the input and the frame, writing no output",
		async (command) => {
			const inputPath = join(workingDirectory, "huge.wav");
			const outputPath = join(workingDirectory, "out.wav");
			const channels = createSine(48000, 2, 48000, 997, 0.1);

			channels[1]?.set([1.7e308], 24000);
			await writeTestWav(inputPath, channels, { bitDepth: "64f" });

			const run = await runCli([...command, inputPath, ...(command[0] === "stats" ? [] : ["-o", outputPath])]);

			expect(run.exitCode).toBe(1);
			expect(run.stderr).toBe(`error: "${inputPath}" overflows the measurement at frame 24000
`);
			expect(run.stdout.length).toBe(0);
			expect(existsSync(outputPath)).toBe(false);
		},
	);
});

describe("--oversampling", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-cli-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const writeOffGridTone = async (path: string): Promise<void> => {
		const channel = Float64Array.from(
			{ length: 2 * 48000 },
			(_, index) => 0.5 * Math.cos(2 * Math.PI * 0.45 * (index - 1 / 16)),
		);

		await writeTestWav(path, [channel], { bitDepth: "64f" });
	};

	const commands = [["stats"], ["tp-norm"], ["lufs-norm"], ["target", "--tp", "-1"], ["crest"]] as const;

	const argvOf = (command: ReadonlyArray<string>, inputPath: string, outputPath: string): Array<string> => [
		...command,
		inputPath,
		...(command[0] === "stats" ? ["--json"] : ["-o", outputPath]),
	];

	it.each(commands.map((command) => [command.join(" "), command] as const))(
		"%s rejects a factor other than 8 or 16",
		async (_, command) => {
			const inputPath = join(workingDirectory, "tone.wav");
			const outputPath = join(workingDirectory, "out.wav");

			await writeOffGridTone(inputPath);

			const run = await runCli([...argvOf(command, inputPath, outputPath), "--oversampling", "4"]);

			expect(run.exitCode).not.toBe(0);
			expect(run.stderr).toContain("oversampling must be 8 or 16, received 4");
			expect(existsSync(outputPath)).toBe(false);
		},
	);

	const truePeakOf = async (path: string): Promise<number> => {
		const run = await runCli(["stats", "--json", "--oversampling", "16", path]);
		const [figures] = JSON.parse(run.stdout.toString("utf8")) as Array<{ readonly truePeakDb: number }>;

		return figures?.truePeakDb ?? Number.NaN;
	};

	it.each([
		["stats", "truePeakDb"],
		["tp-norm", "source true peak"],
		["lufs-norm", "output true peak"],
		["crest", "source true peak"],
	] as const)("%s reads the tone's off-grid peak higher at 16x than at the default 8x", async (name, figure) => {
		const inputPath = join(workingDirectory, "tone.wav");
		const readingOf = async (extra: ReadonlyArray<string>): Promise<number> => {
			const outputPath = join(workingDirectory, `out${extra.length}.wav`);
			const run = await runCli([...argvOf([name], inputPath, outputPath), ...extra]);

			expect(run.exitCode).toBeUndefined();

			if (name === "stats") {
				const [figures] = JSON.parse(run.stdout.toString("utf8")) as Array<{ readonly truePeakDb: number }>;

				return figures?.truePeakDb ?? Number.NaN;
			}

			return printedFigureOf(run.stdout.toString("utf8"), figure) ?? Number.NaN;
		};

		await writeOffGridTone(inputPath);

		const atDefault = await readingOf([]);
		const atSixteen = await readingOf(["--oversampling", "16"]);

		expect(atSixteen - atDefault).toBeGreaterThan(0.03);
		expect(await readingOf(["--oversampling", "8"])).toBe(atDefault);
	});

	it("target holds the true peak at --tp on the 16x meter under --oversampling 16, and above it under the default 8x", async () => {
		const inputPath = join(workingDirectory, "tone.wav");
		const defaultPath = join(workingDirectory, "default.wav");
		const sixteenPath = join(workingDirectory, "sixteen.wav");

		await writeOffGridTone(inputPath);

		expect(
			(await runCli(["target", inputPath, "-o", defaultPath, "--tp", "-1", "--tolerance", "0.05"])).exitCode,
		).toBeUndefined();
		expect(
			(
				await runCli([
					"target",
					inputPath,
					"-o",
					sixteenPath,
					"--tp",
					"-1",
					"--tolerance",
					"0.05",
					"--oversampling",
					"16",
				])
			).exitCode,
		).toBeUndefined();

		const sixteen = await truePeakOf(sixteenPath);

		expect(sixteen).toBeLessThanOrEqual(-1 + 0.005);
		expect(sixteen).toBeGreaterThan(-1.05);
		expect((await truePeakOf(defaultPath)) - sixteen).toBeGreaterThan(0.05);
	});
});
