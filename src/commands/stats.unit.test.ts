import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linearToDb } from "../utils/db";
import { captureWrites, runCli, writeTestWav } from "../utils/testCli";
import { createNoise, createSine } from "../utils/testSignals";
import { Scratch } from "../utils/Scratch";
import { WavSpool } from "../wav/WavSpool";
import { writeExtensibleWav } from "../utils/testWav";
import { WavWriter } from "../wav/WavWriter";
import { stats } from "./stats";

const SAMPLE_RATE = 48000;

const writeWav = async (path: string, channels: Array<Float64Array>, bitDepth: "16" | "32f" = "32f"): Promise<void> => {
	const writer = await WavWriter.create(
		{ kind: "file", path },
		{
			sampleRate: SAMPLE_RATE,
			channelCount: channels.length,
			channelMask: 0,
			bitDepth,
			frameCount: channels[0]?.length ?? 0,
		},
	);

	await writer.write(channels);
	await writer.close();
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

describe("stats", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-stats-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("prints aligned human-readable lines for a single file", async () => {
		const inputPath = join(workingDirectory, "sine.wav");
		const frameCount = 4800;
		const channels = createSine(frameCount, 1, SAMPLE_RATE, 997, 0.5);

		await writeWav(inputPath, channels);

		const { stdout, stderr, exitCode } = await capture(() => stats([inputPath], {}));

		expect(exitCode).toBeUndefined();
		expect(stderr).toBe("");
		expect(stdout).toContain(inputPath);
		expect(stdout).toMatch(/sample rate\s+48000 Hz/);
		expect(stdout).toMatch(/channels\s+1/);
		expect(stdout).toMatch(/bit depth\s+32f/);
		expect(stdout).toMatch(/duration\s+0\.100 s/);
		expect(stdout).toMatch(/true peak\s+-?\d/);
		expect(stdout).toMatch(/integrated\s+n\/a/);
		expect(stdout).toMatch(/loudness range\s+n\/a/);
	});

	it("prints one group per file for multiple inputs", async () => {
		const firstPath = join(workingDirectory, "first.wav");
		const secondPath = join(workingDirectory, "second.wav");

		await writeWav(firstPath, createSine(480, 1, SAMPLE_RATE, 440, 0.5));
		await writeWav(secondPath, createSine(960, 2, SAMPLE_RATE, 220, 0.25), "16");

		const { stdout, exitCode } = await capture(() => stats([firstPath, secondPath], {}));

		expect(exitCode).toBeUndefined();
		expect(stdout.indexOf(firstPath)).toBeGreaterThanOrEqual(0);
		expect(stdout.indexOf(secondPath)).toBeGreaterThan(stdout.indexOf(firstPath));
		expect(stdout).toMatch(/channels\s+1/);
		expect(stdout).toMatch(/channels\s+2/);
		expect(stdout).toMatch(/bit depth\s+16/);
	});

	it("prints a JSON array with pinned key names and nothing else", async () => {
		const inputPath = join(workingDirectory, "json.wav");
		const frameCount = 480;

		await writeWav(inputPath, createSine(frameCount, 2, SAMPLE_RATE, 997, 0.5));

		const { stdout, stderr, exitCode } = await capture(() => stats([inputPath], { json: true }));
		const parsed: unknown = JSON.parse(stdout);

		expect(exitCode).toBeUndefined();
		expect(stderr).toBe("");
		expect(stdout.trim()).toBe(JSON.stringify(parsed));
		expect(Array.isArray(parsed)).toBe(true);

		const [entry] = parsed as Array<Record<string, unknown>>;

		expect(Object.keys(entry ?? {}).slice(0, 6)).toEqual([
			"path",
			"sampleRate",
			"channelCount",
			"bitDepth",
			"durationSeconds",
			"truePeakDb",
		]);
		expect(Object.keys(entry ?? {}).slice(0, 7)).toEqual([
			"path",
			"sampleRate",
			"channelCount",
			"bitDepth",
			"durationSeconds",
			"truePeakDb",
			"integratedLufs",
		]);
		expect(Object.keys(entry ?? {})).toEqual([
			"path",
			"sampleRate",
			"channelCount",
			"bitDepth",
			"durationSeconds",
			"truePeakDb",
			"integratedLufs",
			"loudnessRange",
		]);
		expect(entry?.path).toBe(inputPath);
		expect(entry?.sampleRate).toBe(SAMPLE_RATE);
		expect(entry?.channelCount).toBe(2);
		expect(entry?.bitDepth).toBe("32f");
		expect(entry?.durationSeconds).toBe(frameCount / SAMPLE_RATE);
		expect(typeof entry?.truePeakDb).toBe("number");
		expect(entry?.integratedLufs).toBeNull();
		expect(entry?.loudnessRange).toBeNull();
	});

	it("reports truePeakDb null and human n/a for a zero-frame file", async () => {
		const inputPath = join(workingDirectory, "empty.wav");
		const writer = await WavWriter.create(
			{ kind: "file", path: inputPath },
			{
				sampleRate: SAMPLE_RATE,
				channelCount: 1,
				channelMask: 0,
				bitDepth: "32f",
				frameCount: 0,
			},
		);

		await writer.close();

		const human = await capture(() => stats([inputPath], {}));

		expect(human.exitCode).toBeUndefined();
		expect(human.stdout).toMatch(/true peak\s+n\/a/);
		expect(human.stdout).toMatch(/integrated\s+n\/a/);
		expect(human.stdout).toMatch(/loudness range\s+n\/a/);

		const json = await capture(() => stats([inputPath], { json: true }));
		const parsed = JSON.parse(json.stdout) as Array<{
			truePeakDb: number | null;
			integratedLufs: number | null;
			loudnessRange: number | null;
			durationSeconds: number;
		}>;

		expect(parsed[0]?.truePeakDb).toBeNull();
		expect(parsed[0]?.integratedLufs).toBeNull();
		expect(parsed[0]?.loudnessRange).toBeNull();
		expect(parsed[0]?.durationSeconds).toBe(0);
	});

	it("reports a sine within 0.01 dB of its analytic dBTP", async () => {
		const inputPath = join(workingDirectory, "analytic.wav");
		const amplitude = 0.5;
		const analyticDb = linearToDb(amplitude);

		await writeWav(inputPath, createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, amplitude));

		const { stdout } = await capture(() => stats([inputPath], { json: true }));
		const parsed = JSON.parse(stdout) as Array<{ truePeakDb: number | null }>;

		expect(parsed[0]?.truePeakDb).toEqual(expect.any(Number));
		expect(Math.abs((parsed[0]?.truePeakDb ?? 0) - analyticDb)).toBeLessThan(0.01);
	});

	it("reports a full-scale 997 Hz sine within 0.05 LU of -3.01 LUFS", async () => {
		const inputPath = join(workingDirectory, "full-scale.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE * 5, 1, SAMPLE_RATE, 997, 1));

		const { stdout } = await capture(() => stats([inputPath], { json: true }));
		const parsed = JSON.parse(stdout) as Array<{ integratedLufs: number | null; loudnessRange: number | null }>;

		expect(parsed[0]?.integratedLufs).toEqual(expect.any(Number));
		expect(Math.abs((parsed[0]?.integratedLufs ?? 0) - -3.01)).toBeLessThanOrEqual(0.05);
		expect(parsed[0]?.loudnessRange).toEqual(expect.any(Number));
	});

	it("reports the floored true peak for a 1e-12-peak 32f source", async () => {
		const inputPath = join(workingDirectory, "tiny.wav");
		const tiny = new Float64Array(256).fill(1e-12);

		await writeWav(inputPath, [tiny]);

		const human = await capture(() => stats([inputPath], {}));
		const json = await capture(() => stats([inputPath], { json: true }));
		const parsed = JSON.parse(json.stdout) as Array<{ truePeakDb: number | null }>;

		expect(parsed[0]?.truePeakDb).toEqual(expect.any(Number));
		expect(parsed[0]?.truePeakDb ?? 0).toBeCloseTo(-200, 6);
		expect(human.stdout).toMatch(/true peak\s+-200\.00 dBTP/);
	});

	it("reports the floored true peak for a nonempty silent file", async () => {
		const inputPath = join(workingDirectory, "silent.wav");

		await writeWav(inputPath, [new Float64Array(64)]);

		const human = await capture(() => stats([inputPath], {}));
		const json = await capture(() => stats([inputPath], { json: true }));
		const parsed = JSON.parse(json.stdout) as Array<{ truePeakDb: number | null; durationSeconds: number }>;

		expect(human.stdout).toMatch(/true peak\s+-200\.00 dBTP/);
		expect(parsed[0]?.truePeakDb).toEqual(expect.any(Number));
		expect(parsed[0]?.truePeakDb ?? 0).toBeCloseTo(-200, 6);
		expect(parsed[0]?.durationSeconds).toBeGreaterThan(0);
	});

	it("reports loudnessRange 0 for silence long enough to close short-term windows", async () => {
		const inputPath = join(workingDirectory, "silence.wav");
		const writer = await WavWriter.create(
			{ kind: "file", path: inputPath },
			{
				sampleRate: SAMPLE_RATE,
				channelCount: 1,
				channelMask: 0,
				bitDepth: "32f",
				frameCount: SAMPLE_RATE * 4,
			},
		);

		await writer.write([new Float64Array(SAMPLE_RATE * 4)]);
		await writer.close();

		const human = await capture(() => stats([inputPath], {}));
		const json = await capture(() => stats([inputPath], { json: true }));
		const parsed = JSON.parse(json.stdout) as Array<{ loudnessRange: number | null }>;

		expect(human.stdout).toMatch(/loudness range\s+0\.00 LU/);
		expect(parsed[0]?.loudnessRange).toBe(0);
	});

	it("errors naming an unreadable file, measures the rest, and exits non-zero", async () => {
		const firstPath = join(workingDirectory, "first.wav");
		const missingPath = join(workingDirectory, "missing.wav");
		const unreadablePath = join(workingDirectory, "not-a-wav.txt");
		const lastPath = join(workingDirectory, "last.wav");

		await writeWav(firstPath, createSine(240, 1, SAMPLE_RATE, 440, 0.4));
		await writeFile(unreadablePath, "not a wav");
		await writeWav(lastPath, createSine(240, 1, SAMPLE_RATE, 440, 0.2));

		const { stdout, stderr, exitCode } = await capture(() =>
			stats([firstPath, missingPath, unreadablePath, lastPath], { json: true }),
		);
		const parsed = JSON.parse(stdout) as Array<{ path: string }>;

		expect(exitCode).toBe(1);
		expect(stderr).toMatch(/^error: /m);
		expect(stderr).toContain(missingPath);
		expect(stderr).toContain(unreadablePath);
		expect(parsed.map((entry) => entry.path)).toEqual([firstPath, lastPath]);
	});

	it("measures a 4-channel file among the rest and exits zero", async () => {
		const firstPath = join(workingDirectory, "first.wav");
		const quadPath = join(workingDirectory, "quad.wav");
		const lastPath = join(workingDirectory, "last.wav");

		await writeWav(firstPath, createSine(240, 1, SAMPLE_RATE, 440, 0.4));
		await writeWav(quadPath, createSine(240, 4, SAMPLE_RATE, 440, 0.4));
		await writeWav(lastPath, createSine(240, 1, SAMPLE_RATE, 440, 0.2));

		const { stdout, stderr, exitCode } = await capture(() => stats([firstPath, quadPath, lastPath], { json: true }));
		const parsed = JSON.parse(stdout) as Array<{ path: string; channelCount: number }>;

		expect(exitCode).toBeUndefined();
		expect(stderr).toBe("");
		expect(parsed.map((entry) => [entry.path, entry.channelCount])).toEqual([
			[firstPath, 1],
			[quadPath, 4],
			[lastPath, 1],
		]);
	});

	describe("channel weighting", () => {
		const FULL_SCALE_FRAMES = SAMPLE_RATE * 3;
		const SURROUND_OFFSET_DB = 10 * Math.log10(1.41);

		const sineOnChannel = (channelCount: number, channelIndex: number): Array<Float64Array> => {
			const [sine = new Float64Array(0)] = createSine(FULL_SCALE_FRAMES, 1, SAMPLE_RATE, 997, 1);

			return Array.from({ length: channelCount }, (_channel, index) =>
				index === channelIndex ? sine : new Float64Array(FULL_SCALE_FRAMES),
			);
		};

		const measureJson = async (
			path: string,
		): Promise<{ integratedLufs: number | null; truePeakDb: number | null }> => {
			const { stdout } = await capture(() => stats([path], { json: true }));
			const [result] = JSON.parse(stdout) as Array<{ integratedLufs: number | null; truePeakDb: number | null }>;

			return { integratedLufs: result?.integratedLufs ?? null, truePeakDb: result?.truePeakDb ?? null };
		};

		const measureMasked = async (
			channelCount: number,
			channelMask: number | undefined,
			channelIndex: number,
		): Promise<{ integratedLufs: number | null; truePeakDb: number | null }> => {
			const path = join(workingDirectory, `weighted-${channelCount}-${channelMask ?? "plain"}-${channelIndex}.wav`);
			const channels = sineOnChannel(channelCount, channelIndex);

			await (channelMask === undefined
				? writeWav(path, channels)
				: writeExtensibleWav(path, {
						sampleRate: SAMPLE_RATE,
						channelCount: channels.length,
						bitDepth: "32f",
						channelMask,
						channels,
					}));

			return measureJson(path);
		};

		it("reads a full-scale 997 Hz sine on the centre of a 0x3F file within 0.05 LU of -3.01 LUFS", async () => {
			const centre = await measureMasked(6, 0x3f, 2);

			expect(centre.integratedLufs).toEqual(expect.any(Number));
			expect(Math.abs((centre.integratedLufs ?? 0) - -3.01)).toBeLessThanOrEqual(0.05);
		});

		it.each([
			{ name: "BL of 0x3F", channelCount: 6, channelMask: 0x3f, channelIndex: 4, offsetDb: SURROUND_OFFSET_DB },
			{ name: "SL of 0x60F", channelCount: 6, channelMask: 0x60f, channelIndex: 4, offsetDb: SURROUND_OFFSET_DB },
			{ name: "SR of 0x60F", channelCount: 6, channelMask: 0x60f, channelIndex: 5, offsetDb: SURROUND_OFFSET_DB },
			{ name: "BL of 0x63F", channelCount: 8, channelMask: 0x63f, channelIndex: 4, offsetDb: 0 },
			{ name: "BR of 0x63F", channelCount: 8, channelMask: 0x63f, channelIndex: 5, offsetDb: 0 },
			{ name: "SL of 0x63F", channelCount: 8, channelMask: 0x63f, channelIndex: 6, offsetDb: SURROUND_OFFSET_DB },
			{ name: "SR of 0x63F", channelCount: 8, channelMask: 0x63f, channelIndex: 7, offsetDb: SURROUND_OFFSET_DB },
			{ name: "BC of 0x70F", channelCount: 7, channelMask: 0x70f, channelIndex: 4, offsetDb: 0 },
			{ name: "BC of 0x107", channelCount: 4, channelMask: 0x107, channelIndex: 3, offsetDb: SURROUND_OFFSET_DB },
			{
				name: "the undefined third bit of 0x40003",
				channelCount: 3,
				channelMask: 0x40003,
				channelIndex: 2,
				offsetDb: 0,
			},
			{
				name: "the first channel of 0x80000000",
				channelCount: 2,
				channelMask: 0x80000000,
				channelIndex: 0,
				offsetDb: 0,
			},
			{
				name: "the second channel of 0x80000000",
				channelCount: 2,
				channelMask: 0x80000000,
				channelIndex: 1,
				offsetDb: 0,
			},
			{
				name: "a channel past the popcount of 0x3F",
				channelCount: 7,
				channelMask: 0x3f,
				channelIndex: 6,
				offsetDb: 0,
			},
			{
				name: "the LFE position of a plain 6-channel file",
				channelCount: 6,
				channelMask: undefined,
				channelIndex: 3,
				offsetDb: 0,
			},
		])(
			"weights a sine on $name by its stated position",
			async ({ channelCount, channelMask, channelIndex, offsetDb }) => {
				const centre = await measureMasked(6, 0x3f, 2);
				const measured = await measureMasked(channelCount, channelMask, channelIndex);

				expect(measured.integratedLufs).toEqual(expect.any(Number));
				expect(
					Math.abs((measured.integratedLufs ?? 0) - (centre.integratedLufs ?? 0) - offsetDb),
				).toBeLessThanOrEqual(0.01);
			},
		);

		it("reads a sine on the LFE of a 0x3F file as silence while its true peak counts", async () => {
			const lfe = await measureMasked(6, 0x3f, 3);

			expect(lfe.integratedLufs).toBeNull();
			expect(Math.abs((lfe.truePeakDb ?? -Infinity) - 0)).toBeLessThan(0.1);
		});

		it("leaves mono and stereo figures unchanged by a front mask", async () => {
			const monoPlain = await measureMasked(1, undefined, 0);
			const monoMasked = await measureMasked(1, 0x4, 0);
			const stereoPlain = await measureMasked(2, undefined, 1);
			const stereoMasked = await measureMasked(2, 0x3, 1);

			expect(monoMasked).toEqual(monoPlain);
			expect(stereoMasked).toEqual(stereoPlain);
		});
	});
});

describe("stats on stdin", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-stats-stdin-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	it("measures - among file inputs as the file it carries, with path -", async () => {
		const firstPath = join(workingDirectory, "first.wav");
		const secondPath = join(workingDirectory, "second.wav");

		await writeWav(firstPath, createSine(SAMPLE_RATE, 2, SAMPLE_RATE, 997, 0.25));
		await writeWav(secondPath, createSine(2 * SAMPLE_RATE, 2, SAMPLE_RATE, 440, 0.5), "16");

		const run = await runCli(["stats", firstPath, "-", secondPath, "--json"], await readFile(secondPath));
		const results = JSON.parse(run.stdout.toString("utf8")) as Array<{ path: string }>;

		expect(run.exitCode).toBeUndefined();
		expect(results.map((result) => result.path)).toEqual([firstPath, "-", secondPath]);
		expect(results[1]).toEqual({ ...results[2], path: "-" });
	});

	it("rejects a second - before reading any input", async () => {
		const inputPath = join(workingDirectory, "input.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, 0.5));

		const run = await runCli(["stats", inputPath, "-", "-"], await readFile(inputPath));

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toBe("error: stdin can be read once\n");
		expect(run.stdout.length).toBe(0);
	});

	it("reports a stdin that is not WAV as a file that is not WAV, with path -", async () => {
		const run = await runCli(["stats", "-"], Buffer.from("not a wav stream"));

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toBe('error: Not a WAV file: "-"\n');
	});

	it('prefixes Cannot read "-" to a stdin failure whose message names no path, as for a file', async () => {
		const inputPath = join(workingDirectory, "input.wav");

		await writeWav(inputPath, createSine(SAMPLE_RATE, 1, SAMPLE_RATE, 997, 0.5), "16");

		const input = await readFile(inputPath);

		input.writeUInt16LE(0, 22);

		const run = await runCli(["stats", "-"], input);

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toBe('error: Cannot read "-": Invalid WAV file: channelCount 0\n');
	});
});

describe("raw PCM and pipes across the commands", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-stats-raw-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const statsOf = (run: { readonly stdout: Buffer }): Array<Record<string, unknown>> =>
		JSON.parse(run.stdout.toString("utf8")) as Array<Record<string, unknown>>;

	it("reads a raw input at 44100 Hz mono by default, -ch_layout over -ac, and a 7-byte stereo stdin as one frame", async () => {
		const mono = await runCli(["stats", "-f", "s16le", "-", "--json"], Buffer.alloc(882));
		const layout = await runCli(
			["stats", "-f", "s16le", "-ac", "2", "-ch_layout", "5.1", "-", "--json"],
			Buffer.alloc(24),
		);
		const short = await runCli(["stats", "-f", "s16le", "-ac", "2", "-", "--json"], Buffer.alloc(7));

		expect(statsOf(mono)[0]).toMatchObject({ path: "-", sampleRate: 44100, channelCount: 1, bitDepth: "16" });
		expect(statsOf(mono)[0]?.durationSeconds).toBeCloseTo(441 / 44100, 9);
		expect(statsOf(layout)[0]).toMatchObject({ channelCount: 6 });
		expect(statsOf(short)[0]?.durationSeconds).toBeCloseTo(1 / 44100, 12);
	});

	it("applies an input -ch_layout where its specifier selects the stream, and refuses an output count form that would rematrix", async () => {
		const wavPath = join(workingDirectory, "stereo.wav");

		await writeTestWav(wavPath, createNoise(4800, 2, 4), { bitDepth: "16" });

		const unselected = await runCli(["stats", "-ch_layout:v", "5.1", wavPath, "--json"]);
		const side = await runCli(
			["stats", "-f", "s16le", "-ch_layout:a", "5.1(side)", "-ch_layout:v", "5.1", "-", "--json"],
			Buffer.alloc(24),
		);
		const mismatched = await runCli(
			["stats", "-f", "s16le", "-ch_layout:a", "stereo", "-ch_layout:v", "mono", "-", "--json"],
			Buffer.alloc(4),
		);
		const rematrix = await runCli(
			["tp-norm", "-f", "s16le", "-ch_layout", "5.1(side)", "-", "-f", "s16le", "-ch_layout", "6C", "-o", "-"],
			Buffer.alloc(24),
		);

		expect(unselected.exitCode).toBeUndefined();
		expect(statsOf(unselected)[0]).toMatchObject({ channelCount: 2 });
		expect(statsOf(side)[0]).toMatchObject({ channelCount: 6 });
		expect(mismatched.exitCode).toBe(1);
		expect(mismatched.stderr).toContain('Channel layout "stereo" has 2 channels, and "-" has 1');
		expect(rematrix.exitCode).toBe(1);
		expect(rematrix.stdout.length).toBe(0);
		expect(rematrix.stderr).toContain(
			"output -ch_layout 6C would rematrix the input's layout 0x60f to 6's default layout",
		);
	});

	it("reports a raw stdin input and a WAV file each in its own format", async () => {
		const wavPath = join(workingDirectory, "b.wav");

		await writeTestWav(wavPath, createNoise(4800, 1, 2), { bitDepth: "24" });

		const run = await runCli(
			["stats", "-f", "f32le", "-ar", "48000", "-ac", "2", "-", wavPath, "--json"],
			Buffer.alloc(8 * 4800),
		);

		expect(run.exitCode).toBeUndefined();
		expect(statsOf(run)).toMatchObject([
			{ path: "-", sampleRate: 48000, channelCount: 2, bitDepth: "32f" },
			{ path: wavPath, sampleRate: 48000, channelCount: 1, bitDepth: "24" },
		]);
	});

	it("reads stdin under pipe: names, prints each path as given, and reads a descriptor once", async () => {
		const forms: Array<Awaited<ReturnType<typeof runCli>>> = [];

		for (const path of ["pipe:", "pipe:0", "pipe: 0"]) {
			forms.push(await runCli(["stats", "-f", "s16le", path, "--json"], Buffer.alloc(882)));
		}

		const twice = await runCli(["stats", "-f", "s16le", "-", "pipe:0", "--json"], Buffer.alloc(882));

		expect(forms.map((run) => statsOf(run)[0]?.path)).toEqual(["pipe:", "pipe:0", "pipe: 0"]);
		const descriptorTwice = await runCli(["stats", "pipe:5", "pipe:05", "--json"]);

		expect(twice.stderr).toBe("error: stdin can be read once\n");
		expect(descriptorTwice.stderr).toBe("error: file descriptor 5 can be read once\n");
		expect(twice.exitCode).toBe(1);
	});

	it("reads a raw input without a spool or a scratch directory", async () => {
		const spool = vi.spyOn(WavSpool, "create");
		const scratch = vi.spyOn(Scratch, "create");
		const rawPath = join(workingDirectory, "in.raw");

		await writeFile(rawPath, Buffer.alloc(882));

		const run = await runCli(["stats", "-f", "s16le", rawPath, "-f", "s16le", "-", "--json"], Buffer.alloc(882));

		expect(run.exitCode).toBeUndefined();
		expect(spool).not.toHaveBeenCalled();
		expect(scratch).not.toHaveBeenCalled();
	});

	it("spools a raw file input inside --scratch-dir and leaves it empty", async () => {
		const spool = vi.spyOn(WavSpool, "create");
		const scratchDirectory = join(workingDirectory, "scratch");
		const rawPath = join(workingDirectory, "in.raw");

		await writeFile(rawPath, Buffer.alloc(2 * 2 * 4800, 1));

		const run = await runCli([
			"--scratch-dir",
			scratchDirectory,
			"tp-norm",
			"-f",
			"s16le",
			"-ac",
			"2",
			rawPath,
			"-o",
			join(workingDirectory, "out.wav"),
		]);
		const spoolPath = spool.mock.calls[0]?.[0] ?? "";

		expect(run.exitCode).toBeUndefined();
		expect(relative(scratchDirectory, spoolPath).startsWith("..")).toBe(false);
		expect(await readdir(scratchDirectory)).toEqual([]);
	});

	it.each([
		["stats"],
		["tp-norm", "-o", "-"],
		["lufs-norm", "-o", "-"],
		["crest", "-o", "-"],
		["target", "-o", "-", "--lufs", "-16"],
	])("fails a 4 Hz WAV input in %s", async (name, ...options) => {
		const inputPath = join(workingDirectory, "slow.wav");

		await writeTestWav(inputPath, createNoise(8, 2, 3), { bitDepth: "16", sampleRate: 4 });

		const run = await runCli([name, inputPath, ...options]);

		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("Unsupported sample rate: 4\n");
	});

	it.each([
		["stats"],
		["tp-norm", "-o", "-"],
		["lufs-norm", "-o", "-"],
		["crest", "-o", "-"],
		["target", "-o", "-", "--lufs", "-16"],
	])("fails a WAV and a raw input above 768000 Hz in %s", async (name, ...options) => {
		const inputPath = join(workingDirectory, "fast.wav");

		await writeTestWav(inputPath, createNoise(8, 2, 3), { bitDepth: "16", sampleRate: 768001 });

		const wav = await runCli([name, inputPath, ...options]);
		const raw = await runCli([name, "-f", "s16le", "-ar", "768001", "-", ...options], Buffer.alloc(8));

		expect([wav.exitCode, raw.exitCode]).toEqual([1, 1]);
		expect(wav.stderr).toContain("Unsupported sample rate: 768001\n");
		expect(raw.stderr).toContain("Unsupported sample rate: 768001\n");
	});
});
