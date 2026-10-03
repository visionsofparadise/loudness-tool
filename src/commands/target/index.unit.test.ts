import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelWeightsOf } from "../../measurement/channelWeights";
import { createProgram } from "../../cli";
import { IntegratedLufsAccumulator } from "../../measurement/IntegratedLufsAccumulator";
import { TruePeakAccumulator } from "../../measurement/TruePeakAccumulator";
import { dbToLinear, linearToDb } from "../../utils/db";
import { SampleFile } from "../../utils/SampleFile";
import { Scratch } from "../../utils/Scratch";
import {
	captureWrites,
	expectRawMatchesFileMode,
	runCli,
	runSilenceOnStdin,
	runStdioCombinations,
	writeTestWav,
} from "../../utils/testCli";
import { createNoise, createSine } from "../../utils/testSignals";
import { writeExtensibleWav } from "../../utils/testWav";
import { WavWriter } from "../../wav/WavWriter";
import { stats } from "../stats";
import { pushWavBlocks, withWavReader } from "../utils/withWavReader";
import { target } from "./index";

const SAMPLE_RATE = 48000;

const writeWav = async (path: string, channels: Array<Float64Array>): Promise<void> => {
	const writer = await WavWriter.create(
		{ kind: "file", path },
		{
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			channelMask: 0,
			bitDepth: "32f",
			frameCount: channels[0]?.length ?? 0,
		},
	);

	await writer.write(channels);
	await writer.close();
};

const makeCrossAxis = (seconds: number): Float64Array => {
	const frameCount = SAMPLE_RATE * seconds;
	const channel = new Float64Array(frameCount);
	const bed = dbToLinear(-30);
	const impulse = dbToLinear(-3);
	const period = Math.round(SAMPLE_RATE / 8);
	const impulseStart = SAMPLE_RATE;
	const impulseEnd = SAMPLE_RATE * 2;

	for (let index = 0; index < frameCount; index++) {
		const sine = bed * Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE);

		channel[index] = index >= impulseStart && index < impulseEnd && index % period === 0 ? impulse : sine;
	}

	return channel;
};

const measureFile = async (path: string): Promise<{ integratedLufs: number; truePeakDb: number }> =>
	withWavReader(path, async (reader) => {
		const lufs = new IntegratedLufsAccumulator(
			reader.format.sampleRate,
			channelWeightsOf(reader.format.channelCount, reader.format.channelMask),
		);
		const truePeak = new TruePeakAccumulator(reader.format.channelCount);

		await pushWavBlocks(reader, [lufs, truePeak]);

		return {
			integratedLufs: lufs.finalize(),
			truePeakDb: linearToDb(truePeak.finalize()),
		};
	});

const reportedFigureOf = (stdout: string, label: string): number => {
	const match = new RegExp(`^${label} +(-?\\d+\\.\\d{2}) `, "m").exec(stdout);

	if (match?.[1] === undefined) {
		throw new Error(`no ${label} figure in the report`);
	}

	return Number(match[1]);
};

const capture = async (
	run: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> => {
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	const writeOut = vi
		.spyOn(process.stdout, "write")
		.mockImplementation(captureWrites((chunk) => stdout.push(chunk.toString("utf8"))));
	const writeErr = vi
		.spyOn(process.stderr, "write")
		.mockImplementation(captureWrites((chunk) => stderr.push(chunk.toString("utf8"))));
	const previousExitCode = process.exitCode;

	process.exitCode = undefined;

	try {
		await run();

		return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode };
	} finally {
		writeOut.mockRestore();
		writeErr.mockRestore();
		process.exitCode = previousExitCode;
	}
};

const ENVELOPE_CLOSE_FAILURE = "injected envelope close failure";

const spyRejectingDetectionClose = () => {
	const originalCreate = SampleFile.create.bind(SampleFile);

	return vi.spyOn(SampleFile, "create").mockImplementation(async (createScratch, label) => {
		const file = await originalCreate(createScratch, label);

		if (label === "detection") {
			vi.spyOn(file, "close").mockImplementation(async () => {
				await SampleFile.prototype.close.call(file);

				throw new Error(ENVELOPE_CLOSE_FAILURE);
			});
		}

		return file;
	});
};

const parseProgram = (argv: Array<string>) => {
	const program = createProgram();
	const silence = {
		writeOut: () => undefined,
		writeErr: () => undefined,
	};

	program.exitOverride();
	program.configureOutput(silence);

	for (const command of program.commands) {
		command.exitOverride();
		command.configureOutput(silence);
	}

	return program.parseAsync(argv, { from: "user" });
};

describe("target", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-target-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("rejects out-of-range flags", async () => {
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--lufs", "-51"])).rejects.toThrow(
			/lufs must be in \[-50, 0\]/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--lufs", "0.1"])).rejects.toThrow(
			/lufs must be in \[-50, 0\]/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--tp", "0"])).rejects.toThrow(
			/tp must be in \[-24, 0\)/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--pivot", "1"])).rejects.toThrow(
			/pivot must be in \[-80, 0\)/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--floor", "0"])).rejects.toThrow(
			/floor must be in \[-100, 0\)/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--limit-percentile", "0.4"])).rejects.toThrow(
			/limit-percentile must be in \[0.5, 1.0\]/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--limit-db", "0"])).rejects.toThrow(
			/limit-db must be in \[-60, 0\)/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--smoothing", "0"])).rejects.toThrow(
			/smoothing must be in \[0.01, 200\]/,
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--tolerance", "0"])).rejects.toThrow(
			/tolerance must be in \(0, 6\]/,
		);
	});

	it("rejects each donor bound at the CLI parser and the exported function", async () => {
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--tp", "-400"])).rejects.toThrow(
			/tp must be in \[-24, 0\), received -400/,
		);
		await expect(target("in.wav", { output: "out.wav", tp: -400 })).rejects.toThrow(
			"tp must be in [-24, 0), received -400",
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--pivot", "-90"])).rejects.toThrow(
			/pivot must be in \[-80, 0\), received -90/,
		);
		await expect(target("in.wav", { output: "out.wav", pivot: -90 })).rejects.toThrow(
			"pivot must be in [-80, 0), received -90",
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--floor", "-101"])).rejects.toThrow(
			/floor must be in \[-100, 0\), received -101/,
		);
		await expect(target("in.wav", { output: "out.wav", floor: -101 })).rejects.toThrow(
			"floor must be in [-100, 0), received -101",
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--limit-db", "-61"])).rejects.toThrow(
			/limit-db must be in \[-60, 0\), received -61/,
		);
		await expect(target("in.wav", { output: "out.wav", limitDb: -61 })).rejects.toThrow(
			"limit-db must be in [-60, 0), received -61",
		);
	});

	it("rejects each remaining donor bound at the CLI parser and the exported function", async () => {
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--lufs", "-16.15"])).rejects.toThrow(
			/lufs must be in \[-50, 0\] in steps of 0\.1, received -16\.15/,
		);
		await expect(target("in.wav", { output: "out.wav", lufs: -16.15 })).rejects.toThrow(
			"lufs must be in [-50, 0] in steps of 0.1, received -16.15",
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--tolerance", "6.5"])).rejects.toThrow(
			/tolerance must be in \(0, 6\], received 6\.5/,
		);
		await expect(target("in.wav", { output: "out.wav", tolerance: 6.5 })).rejects.toThrow(
			"tolerance must be in (0, 6], received 6.5",
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--smoothing", "200.5"])).rejects.toThrow(
			/smoothing must be in \[0\.01, 200\], received 200\.5/,
		);
		await expect(target("in.wav", { output: "out.wav", smoothing: 200.5 })).rejects.toThrow(
			"smoothing must be in [0.01, 200], received 200.5",
		);
		await expect(parseProgram(["target", "in.wav", "-o", "out.wav", "--limit-percentile", "1.5"])).rejects.toThrow(
			/limit-percentile must be in \[0\.5, 1\.0\], received 1\.5/,
		);
		await expect(target("in.wav", { output: "out.wav", limitPercentile: 1.5 })).rejects.toThrow(
			"limit-percentile must be in [0.5, 1.0], received 1.5",
		);
	});

	it("accepts each donor lower edge", async () => {
		const inputPath = join(workingDirectory, "bound-silent.wav");
		const cliOutputPath = join(workingDirectory, "bound-silent-cli.wav");
		const functionOutputPath = join(workingDirectory, "bound-silent-fn.wav");

		await writeWav(inputPath, [new Float64Array(64)]);

		const cli = await capture(async () => {
			await parseProgram([
				"target",
				inputPath,
				"-o",
				cliOutputPath,
				"--tp",
				"-24",
				"--pivot",
				"-80",
				"--floor",
				"-100",
				"--limit-db",
				"-60",
			]);
		});
		const direct = await capture(() =>
			target(inputPath, {
				output: functionOutputPath,
				tp: -24,
				pivot: -80,
				floor: -100,
				limitDb: -60,
			}),
		);

		expect(cli.exitCode).toBeUndefined();
		expect(direct.exitCode).toBeUndefined();
		expect(cli.stderr).toMatch(/no measurable loudness/);
		expect(direct.stderr).toMatch(/no measurable loudness/);
	});

	it("accepts each remaining donor edge", async () => {
		const inputPath = join(workingDirectory, "edge-silent.wav");
		const cliOutputPath = join(workingDirectory, "edge-silent-cli.wav");
		const functionOutputPath = join(workingDirectory, "edge-silent-fn.wav");

		await writeWav(inputPath, [new Float64Array(64)]);

		const cli = await capture(async () => {
			await parseProgram([
				"target",
				inputPath,
				"-o",
				cliOutputPath,
				"--lufs",
				"-16.1",
				"--limit-percentile",
				"0.5",
				"--smoothing",
				"0.01",
				"--tolerance",
				"6",
			]);
		});
		const direct = await capture(() =>
			target(inputPath, {
				output: functionOutputPath,
				lufs: -50,
				limitPercentile: 1,
				smoothing: 200,
				tolerance: 6,
			}),
		);

		expect(cli.exitCode).toBeUndefined();
		expect(direct.exitCode).toBeUndefined();
		expect(cli.stderr).toMatch(/no measurable loudness/);
		expect(direct.stderr).toMatch(/no measurable loudness/);
	});

	it("rejects floor >= pivot when both are supplied", async () => {
		await expect(
			parseProgram(["target", "in.wav", "-o", "out.wav", "--floor", "-10", "--pivot", "-20"]),
		).rejects.toThrow(/floor must be < pivot/);
	});

	it("fits a cross-axis fixture inside the never-exceed box", async () => {
		const inputPath = join(workingDirectory, "crossaxis.wav");
		const outputPath = join(workingDirectory, "crossaxis-out.wav");
		const scratchDir = join(workingDirectory, "scratch");

		await writeWav(inputPath, [makeCrossAxis(3)]);

		const { stdout, stderr, exitCode } = await capture(() =>
			target(inputPath, {
				output: outputPath,
				lufs: -20,
				tp: -6,
				scratchDir,
			}),
		);
		const measured = await measureFile(outputPath);

		expect(exitCode).toBeUndefined();
		expect(stderr).toMatch(/attempt 1/);
		expect(stdout).toMatch(/output integrated/);
		expect(stdout).toMatch(/converged/);
		expect(measured.integratedLufs).toBeLessThanOrEqual(-20 + 0.01);
		expect(measured.truePeakDb).toBeLessThanOrEqual(-6 + 0.01);
		expect(await readdir(scratchDir)).toEqual([]);
	}, 30_000);

	it("rejects a run with neither --lufs nor --tp and leaves the destination untouched", async () => {
		const inputPath = join(workingDirectory, "no-target.wav");
		const outputPath = join(workingDirectory, "no-target-out.wav");
		const scratchDir = join(workingDirectory, "scratch-no-target");
		const destinationBytes = Buffer.from("existing destination");

		await writeWav(inputPath, [makeCrossAxis(1)]);
		await writeFile(outputPath, destinationBytes);
		await mkdir(scratchDir, { recursive: true });

		const scratchCreate = vi.spyOn(Scratch, "create");

		await expect(parseProgram(["target", inputPath, "-o", outputPath])).rejects.toThrow(
			"at least one of --lufs and --tp is required",
		);
		await expect(target(inputPath, { output: outputPath, scratchDir })).rejects.toThrow(
			"at least one of --lufs and --tp is required",
		);

		expect(scratchCreate).not.toHaveBeenCalled();
		expect(Buffer.compare(await readFile(outputPath), destinationBytes)).toBe(0);
		expect(await readdir(scratchDir)).toEqual([]);
	});

	it("lands the true peak on --tp alone and reports both output figures", async () => {
		const inputPath = join(workingDirectory, "tp-only.wav");
		const outputPath = join(workingDirectory, "tp-only-out.wav");
		const targetTp = -6;
		const tolerance = 0.5;

		await writeWav(inputPath, [makeCrossAxis(3)]);

		const { stdout, stderr, exitCode } = await capture(() =>
			target(inputPath, { output: outputPath, tp: targetTp, tolerance }),
		);
		const measured = await measureFile(outputPath);

		expect(exitCode).toBeUndefined();
		expect(measured.truePeakDb).toBeLessThanOrEqual(targetTp + 0.01);
		expect(Math.abs(measured.truePeakDb - targetTp)).toBeLessThan(tolerance);
		expect(Math.abs(reportedFigureOf(stdout, "output true peak") - measured.truePeakDb)).toBeLessThan(0.01);
		expect(Math.abs(reportedFigureOf(stdout, "output integrated") - measured.integratedLufs)).toBeLessThan(0.01);
		expect(stderr).toMatch(/peakErr/);
		expect(stderr).not.toMatch(/lufsErr/);
	}, 30_000);

	it("lands loudness on --lufs alone and reports the unconstrained true peak", async () => {
		const inputPath = join(workingDirectory, "lufs-only.wav");
		const outputPath = join(workingDirectory, "lufs-only-out.wav");
		const targetLufs = -20;
		const tolerance = 0.5;

		await writeWav(inputPath, [makeCrossAxis(3)]);

		const { stdout, stderr, exitCode } = await capture(() =>
			target(inputPath, { output: outputPath, lufs: targetLufs, limitDb: -10, tolerance }),
		);
		const measured = await measureFile(outputPath);

		expect(exitCode).toBeUndefined();
		expect(measured.integratedLufs).toBeLessThanOrEqual(targetLufs + 0.01);
		expect(Math.abs(measured.integratedLufs - targetLufs)).toBeLessThan(tolerance);
		expect(measured.truePeakDb).toBeGreaterThan(-1);
		expect(Math.abs(reportedFigureOf(stdout, "output integrated") - measured.integratedLufs)).toBeLessThan(0.01);
		expect(Math.abs(reportedFigureOf(stdout, "output true peak") - measured.truePeakDb)).toBeLessThan(0.01);
		expect(stderr).toMatch(/lufsErr/);
		expect(stderr).not.toMatch(/peakErr/);
	}, 30_000);

	it("warns when pivot auto-derivation falls back", async () => {
		const inputPath = join(workingDirectory, "short-source.wav");
		const fallbackOutputPath = join(workingDirectory, "short-source-fallback.wav");
		const pivotOutputPath = join(workingDirectory, "short-source-pivot.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE * 2, 1, SAMPLE_RATE, 1000, 0.1));

		const fallback = await capture(() => target(inputPath, { output: fallbackOutputPath, lufs: -16 }));
		const explicit = await capture(() => target(inputPath, { output: pivotOutputPath, lufs: -16, pivot: -40 }));

		expect(fallback.exitCode).toBeUndefined();
		expect(fallback.stdout).toMatch(/output integrated/);
		expect(fallback.stderr).toMatch(
			/pivot auto-derivation produced no considered LRA blocks; falling back to -40 dB\. Supply --pivot explicitly for tighter control on short or near-silent sources/,
		);
		expect(explicit.stderr).not.toMatch(/pivot auto-derivation/);
	}, 60_000);

	it("lands loudness on --lufs for a 5.1 source with its signal on the front channels", async () => {
		const inputPath = join(workingDirectory, "surround.wav");
		const outputPath = join(workingDirectory, "surround-out.wav");
		const targetLufs = -20;
		const tolerance = 0.5;
		const front = makeCrossAxis(3);
		const channels = Array.from({ length: 6 }, (_channel, index) =>
			index < 3 ? front : new Float64Array(front.length),
		);

		await writeExtensibleWav(inputPath, {
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			bitDepth: "32f",
			channelMask: 0x3f,
			channels,
		});

		const { stdout, exitCode } = await capture(() =>
			target(inputPath, { output: outputPath, lufs: targetLufs, limitDb: -10, tolerance }),
		);
		const statsRun = await capture(() => stats([outputPath], { json: true }));
		const [measured] = JSON.parse(statsRun.stdout) as Array<{ channelCount: number; integratedLufs: number }>;

		expect(exitCode).toBeUndefined();
		expect(measured?.channelCount).toBe(6);
		expect(Math.abs((measured?.integratedLufs ?? 0) - targetLufs)).toBeLessThan(tolerance);
		expect(Math.abs(reportedFigureOf(stdout, "output integrated") - (measured?.integratedLufs ?? 0))).toBeLessThan(
			0.01,
		);
	}, 30_000);

	it("reports and lands --lufs by the stated weights for a 5.1 source with its signal on BL and LFE", async () => {
		const inputPath = join(workingDirectory, "surround-rear.wav");
		const outputPath = join(workingDirectory, "surround-rear-out.wav");
		const targetLufs = -20;
		const tolerance = 0.5;
		const rear = makeCrossAxis(3);
		const channels = Array.from({ length: 6 }, (_channel, index) =>
			index === 3 || index === 4 ? rear : new Float64Array(rear.length),
		);

		await writeExtensibleWav(inputPath, {
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			bitDepth: "32f",
			channelMask: 0x3f,
			channels,
		});

		const { stdout, exitCode } = await capture(() =>
			target(inputPath, { output: outputPath, lufs: targetLufs, limitDb: -10, tolerance }),
		);
		const weightedOutputLufs = await withWavReader(outputPath, async (reader) => {
			const lufs = new IntegratedLufsAccumulator(reader.format.sampleRate, channelWeightsOf(6, 0x3f));

			await pushWavBlocks(reader, [lufs]);

			return lufs.finalize();
		});

		expect(exitCode).toBeUndefined();
		expect(Math.abs(weightedOutputLufs - targetLufs)).toBeLessThan(tolerance);
		expect(Math.abs(reportedFigureOf(stdout, "output integrated") - weightedOutputLufs)).toBeLessThan(0.01);
	}, 30_000);

	it("lands --lufs as stats measures it for a 0x3F source with its signal on every channel", async () => {
		const inputPath = join(workingDirectory, "surround-all.wav");
		const outputPath = join(workingDirectory, "surround-all-out.wav");
		const targetLufs = -20;
		const tolerance = 0.5;
		const signal = makeCrossAxis(3);
		const channels = Array.from({ length: 6 }, () => Float64Array.from(signal));

		await writeExtensibleWav(inputPath, {
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			bitDepth: "32f",
			channelMask: 0x3f,
			channels,
		});

		const { stdout, exitCode } = await capture(() =>
			target(inputPath, { output: outputPath, lufs: targetLufs, limitDb: -10, tolerance }),
		);
		const statsRun = await capture(() => stats([outputPath], { json: true }));
		const [measured] = JSON.parse(statsRun.stdout) as Array<{ channelCount: number; integratedLufs: number }>;
		const outputMask = await withWavReader(outputPath, async (reader) => reader.format.channelMask);

		expect(exitCode).toBeUndefined();
		expect(outputMask).toBe(0x3f);
		expect(measured?.channelCount).toBe(6);
		expect(Math.abs((measured?.integratedLufs ?? 0) - targetLufs)).toBeLessThan(tolerance);
		expect(Math.abs(reportedFigureOf(stdout, "output integrated") - (measured?.integratedLufs ?? 0))).toBeLessThan(
			0.01,
		);
	}, 30_000);

	it("copies an unmeasurable source byte-identically", async () => {
		const inputPath = join(workingDirectory, "silence.wav");
		const outputPath = join(workingDirectory, "silence-out.wav");

		await writeWav(inputPath, [new Float64Array(SAMPLE_RATE)]);

		const { stdout, stderr, exitCode } = await capture(() => target(inputPath, { output: outputPath, lufs: -16 }));

		expect(exitCode).toBeUndefined();
		expect(stdout).toBe("");
		expect(stderr).toMatch(/no measurable loudness/);
		expect(Buffer.compare(await readFile(inputPath), await readFile(outputPath))).toBe(0);
	});

	it("supports in-place -o <input>", async () => {
		const inputPath = join(workingDirectory, "inplace.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE * 2, 1, SAMPLE_RATE, 997, dbToLinear(-20)));
		await capture(() => target(inputPath, { output: inputPath, lufs: -16 }));

		const measured = await measureFile(inputPath);

		expect(measured.integratedLufs).toBeLessThanOrEqual(-16 + 0.5);
		expect(existsSync(inputPath)).toBe(true);
	}, 30_000);

	it("cleans scratch on an injected write failure", async () => {
		const inputPath = join(workingDirectory, "fail.wav");
		const scratchDir = join(workingDirectory, "scratch-fail");
		const outputPath = join(workingDirectory, "missing", "out.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-20)));
		await mkdir(scratchDir, { recursive: true });

		await expect(capture(() => target(inputPath, { output: outputPath, lufs: -16, scratchDir }))).rejects.toThrow();

		expect(await readdir(scratchDir)).toEqual([]);
	});

	it("aggregates a rejecting close with the primary failure", async () => {
		const inputPath = join(workingDirectory, "aggregate.wav");
		const outputPath = join(workingDirectory, "missing", "aggregate-out.wav");
		const scratchDir = join(workingDirectory, "scratch-aggregate");

		await mkdir(scratchDir, { recursive: true });
		await writeWav(inputPath, [new Float64Array(SAMPLE_RATE)]);

		const createSpy = spyRejectingDetectionClose();

		try {
			const thrown: unknown = await capture(() =>
				target(inputPath, { output: outputPath, lufs: -16, scratchDir }),
			).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(thrown).toBeInstanceOf(AggregateError);

			const messages = (thrown as AggregateError).errors.map((error: Error) => error.message);

			expect(messages.some((message) => message.includes("ENOENT"))).toBe(true);
			expect(messages).toContain(ENVELOPE_CLOSE_FAILURE);
			expect(await readdir(scratchDir)).toEqual([]);
		} finally {
			createSpy.mockRestore();
		}
	});

	it("disposes the scratch when the winning envelope's close rejects", async () => {
		const inputPath = join(workingDirectory, "close-reject.wav");
		const outputPath = join(workingDirectory, "close-reject-out.wav");
		const scratchDir = join(workingDirectory, "scratch-close-reject");

		await mkdir(scratchDir, { recursive: true });
		await writeWav(inputPath, [new Float64Array(SAMPLE_RATE)]);

		const createSpy = spyRejectingDetectionClose();

		try {
			await expect(capture(() => target(inputPath, { output: outputPath, lufs: -16, scratchDir }))).rejects.toThrow(
				ENVELOPE_CLOSE_FAILURE,
			);

			expect(await readdir(scratchDir)).toEqual([]);
		} finally {
			createSpy.mockRestore();
		}
	});
});

describe("target on stdin and stdout", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-target-stdio-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("reads - and writes -o - byte-identically to file mode, printing the summary to stderr for -o -", async () => {
		const inputPath = join(workingDirectory, "input.wav");

		await writeWav(inputPath, createSine(2 * SAMPLE_RATE, 2, SAMPLE_RATE, 997, 0.3));

		const runs = await runStdioCombinations({
			command: ["target", "--lufs", "-16"],
			inputPath,
			directory: workingDirectory,
		});
		const stdoutSummary = runs.fileRun.stderr + runs.summaryFor("-");

		expect(runs.fileRun.exitCode).toBeUndefined();
		expect(runs.fileOutput.length).toBeGreaterThan(0);
		expect(runs.stdinOutput.equals(runs.fileOutput)).toBe(true);
		expect(runs.stdoutRun.stdout.equals(runs.fileOutput)).toBe(true);
		expect(runs.pipeRun.stdout.equals(runs.fileOutput)).toBe(true);
		expect(runs.stdinRun.stdout.toString("utf8")).toBe(runs.summaryFor(runs.stdinPath));
		expect(runs.stdinRun.stderr).toBe(runs.fileRun.stderr);
		expect(runs.stdoutRun.stderr).toBe(stdoutSummary);
		expect(runs.pipeRun.stderr).toBe(stdoutSummary);
		expect(runs.pipeRun.stderr).toMatch(/output {4,}-\n$/);
		expect([runs.stdinRun.exitCode, runs.stdoutRun.exitCode, runs.pipeRun.exitCode]).toEqual([
			undefined,
			undefined,
			undefined,
		]);
	});

	it("passes silence on stdin through to the input's samples", async () => {
		const inputPath = join(workingDirectory, "silence.wav");

		await writeWav(inputPath, [new Float64Array(4800), new Float64Array(4800)]);

		const runs = await runSilenceOnStdin({
			command: ["target", "--lufs", "-16"],
			inputPath,
			directory: workingDirectory,
		});

		expect(runs.fileRun.exitCode).toBeUndefined();
		expect(runs.pipeRun.exitCode).toBeUndefined();
		expect(runs.pipeRun.stderr).toContain("passed through unchanged");
		expect(runs.fileSamples).toEqual(runs.inputSamples);
		expect(runs.pipeSamples).toEqual(runs.inputSamples);
	});
});

describe("target on raw PCM", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-target-raw-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("writes the file-mode output's data bytes for raw s24le in and out, and its samples from a raw file", async () => {
		const inputPath = join(workingDirectory, "input.wav");

		await writeTestWav(inputPath, createNoise(96000, 2, 7), { bitDepth: "24" });
		await expectRawMatchesFileMode({
			command: ["target", "--lufs", "-16"],
			inputPath,
			directory: workingDirectory,
		});
	}, 60_000);

	it("passes raw silence through as its input bytes and as zero floats under -f f32le", async () => {
		const silence = Buffer.alloc(2 * 2 * 4800);
		const raw = ["-f", "s16le", "-ar", "48000", "-ac", "2", "-"];
		const same = await runCli(["target", ...raw, "-f", "s16le", "-o", "-", "--lufs", "-16"], silence);
		const floats = await runCli(["target", ...raw, "-f", "f32le", "-o", "-", "--lufs", "-16"], silence);

		expect([same.exitCode, floats.exitCode]).toEqual([undefined, undefined]);
		expect(same.stdout.equals(silence)).toBe(true);
		expect(floats.stdout.equals(Buffer.alloc(4 * 2 * 4800))).toBe(true);
	});
});
