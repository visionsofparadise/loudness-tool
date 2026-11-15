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

	it.each([
		[["stats"]],
		[["tp-norm"]],
		[["lufs-norm"]],
		[["target", "--lufs", "-16", "--tp", "-1"]],
		[["crest"]],
		[["stats", "--oversampling", "16"]],
		[["tp-norm", "--oversampling", "16"]],
	])("fails %j naming the input and the frame, writing no output", async (command) => {
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
	});
});

describe("--oversampling", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-cli-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const FADE_FRAMES = 0.05 * 48000;

	const writeOffGridTone = async (path: string, seconds: number, amplitude: number): Promise<void> => {
		const length = Math.round(seconds * 48000);
		const channel = Float64Array.from({ length }, (_, index) => {
			const edge = Math.min(index, length - 1 - index);
			const fade = edge < FADE_FRAMES ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / FADE_FRAMES) : 1;

			return amplitude * fade * Math.cos(2 * Math.PI * 0.4 * (index - 1 / 16));
		});

		await writeTestWav(path, [channel], { bitDepth: "64f" });
	};

	const commands: ReadonlyArray<ReadonlyArray<string>> = [
		["stats"],
		["tp-norm"],
		["lufs-norm"],
		["target", "--tp", "-1"],
		["crest"],
	];

	const argvOf = (command: ReadonlyArray<string>, inputPath: string, outputPath: string): Array<string> => [
		...command,
		inputPath,
		...(command[0] === "stats" ? ["--json"] : ["-o", outputPath]),
	];

	const truePeakOf = async (path: string): Promise<number> => {
		const run = await runCli(["stats", "--json", "--oversampling", "16", path]);
		const [figures] = JSON.parse(run.stdout.toString("utf8")) as Array<{ readonly truePeakDb: number }>;

		return figures?.truePeakDb ?? Number.NaN;
	};

	it.each(commands.map((command) => [command.join(" "), command] as const))(
		"%s rejects a factor other than 8 or 16, written as anything but 8 or 16",
		async (_, command) => {
			const inputPath = join(workingDirectory, "tone.wav");
			const outputPath = join(workingDirectory, "out.wav");

			await writeOffGridTone(inputPath, 2, 0.5);

			for (const value of ["4", "0x10", "16.0", " 16"]) {
				const run = await runCli([...argvOf(command, inputPath, outputPath), "--oversampling", value]);

				expect(run.exitCode).not.toBe(0);
				expect(run.stderr).toContain(`oversampling must be 8 or 16, received ${value}`);
				expect(existsSync(outputPath)).toBe(false);
			}
		},
	);

	it.each([
		["stats", "truePeakDb"],
		["tp-norm", "source true peak"],
		["lufs-norm", "output true peak"],
		["crest", "source true peak"],
	] as const)(
		"%s reads a 0.4 fs tone's off-grid peak about 0.1 dB higher at 16x than at the default 8x",
		async (name, figure) => {
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

			await writeOffGridTone(inputPath, 2, 0.5);

			const atDefault = await readingOf([]);
			const atSixteen = await readingOf(["--oversampling", "16"]);

			expect(atSixteen - atDefault).toBeGreaterThan(0.07);
			expect(await readingOf(["--oversampling", "8"])).toBe(atDefault);
		},
	);

	const targetRun = async (
		inputPath: string,
		outputPath: string,
		options: ReadonlyArray<string>,
	): Promise<{ readonly stdout: string; readonly stderr: string; readonly sixteen: number }> => {
		const run = await runCli(["target", inputPath, "-o", outputPath, ...options]);

		expect(run.exitCode).toBeUndefined();

		return {
			stdout: run.stdout.toString("utf8"),
			stderr: run.stderr,
			sixteen: await truePeakOf(outputPath),
		};
	};

	it("target meters its attempts at the chosen factor, holding --tp on the 16x meter under --oversampling 16", async () => {
		const inputPath = join(workingDirectory, "tone.wav");

		await writeOffGridTone(inputPath, 2, 0.5);

		const options = ["--tp", "-1", "--tolerance", "0.05"];
		const atDefault = await targetRun(inputPath, join(workingDirectory, "default.wav"), options);
		const atSixteen = await targetRun(inputPath, join(workingDirectory, "sixteen.wav"), [
			...options,
			"--oversampling",
			"16",
		]);

		expect(printedFigureOf(atSixteen.stdout, "output true peak")).toBe(Number(atSixteen.sixteen.toFixed(2)));
		expect(atSixteen.sixteen).toBeLessThanOrEqual(-1 + 0.005);
		expect(atSixteen.sixteen).toBeGreaterThan(-1.05);
		expect(atDefault.sixteen - atSixteen.sixteen).toBeGreaterThan(0.07);
	});

	it("target lowers a source with no measurable loudness to --tp on the chosen factor's reading", async () => {
		const inputPath = join(workingDirectory, "short.wav");

		await writeOffGridTone(inputPath, 0.3, 0.99);

		const options = ["--lufs", "-16", "--tp", "-1"];
		const atDefault = await targetRun(inputPath, join(workingDirectory, "default.wav"), options);
		const atSixteen = await targetRun(inputPath, join(workingDirectory, "sixteen.wav"), [
			...options,
			"--oversampling",
			"16",
		]);

		expect(atSixteen.stderr).toContain("source has no measurable loudness; lowered to the true-peak target");
		expect(Math.abs(atSixteen.sixteen + 1)).toBeLessThan(0.005);
		expect(atDefault.sixteen - atSixteen.sixteen).toBeGreaterThan(0.07);
	});
});
