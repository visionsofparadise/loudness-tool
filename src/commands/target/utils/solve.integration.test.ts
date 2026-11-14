import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbToLinear } from "../../../utils/db";
import { decodedSamplesOf, runCli, writeTestWav } from "../../../utils/testCli";
import { createNoise, createSine, createSpeechLike, type SpeechLike } from "../../../utils/testSignals";

const SAMPLE_RATE = 48000;
const TOLERANCE = 0.5;
const GRAIN = 0.01;

interface StatsFigures {
	readonly integratedLufs: number | null;
	readonly truePeakDb: number | null;
	readonly loudnessRange: number | null;
}

const statsOf = async (path: string): Promise<StatsFigures> => {
	const run = await runCli(["stats", "--json", path]);
	const [figures] = JSON.parse(run.stdout.toString("utf8")) as Array<StatsFigures>;

	if (figures === undefined) {
		throw new Error(`stats printed no figures for ${path}`);
	}

	return figures;
};

const printedFigureOf = (stdout: string, label: string): number | null => {
	const match = new RegExp(`^${label} +(n/a|-?\\d+\\.\\d+)`, "m").exec(stdout);

	if (match?.[1] === undefined) {
		throw new Error(`no ${label} line in: ${stdout}`);
	}

	return match[1] === "n/a" ? null : Number(match[1]);
};

const rmsDbOf = (channel: Float64Array, start: number, end: number): number => {
	let sum = 0;

	for (let index = start; index < end; index++) {
		sum += (channel[index] ?? 0) ** 2;
	}

	return 10 * Math.log10(sum / (end - start));
};

const scaled = (channels: ReadonlyArray<Float64Array>, gain: number): Array<Float64Array> =>
	channels.map((channel) => channel.map((sample) => sample * gain));

const NOISE_RMS = 1 / Math.sqrt(3);
const BACKGROUND_CLEARANCE_SECONDS = 0.1;
const UNREACHABLE_PATTERN = /^target unreachable: loudness stops rising at (-?\d+\.\d+) LUFS$/m;

const largestBackgroundGainDbOf = (
	speech: SpeechLike,
	input: Float64Array,
	output: Float64Array,
	sampleRate: number,
): { readonly windows: number; readonly largestDb: number } => {
	const windowFrames = Math.round(0.02 * sampleRate);
	const clearance = Math.round(BACKGROUND_CLEARANCE_SECONDS * sampleRate);
	let windows = 0;
	let largestDb = 0;

	for (let start = 0; start + windowFrames <= input.length; start += windowFrames) {
		const centre = start + windowFrames / 2;
		const isClear = speech.activeSpans.every(
			([spanStart, spanEnd]) => centre < spanStart - clearance || centre >= spanEnd + clearance,
		);

		if (isClear) {
			windows++;
			largestDb = Math.max(
				largestDb,
				Math.abs(rmsDbOf(output, start, start + windowFrames) - rmsDbOf(input, start, start + windowFrames)),
			);
		}
	}

	return { windows, largestDb };
};

describe("target's search", () => {
	let workingDirectory: string;

	beforeEach(async () => {
		workingDirectory = await mkdtemp(join(tmpdir(), "loudness-tool-target-search-"));
	});

	afterEach(async () => {
		await rm(workingDirectory, { recursive: true, force: true });
	});

	const runTarget = async (
		name: string,
		channels: ReadonlyArray<Float64Array>,
		options: ReadonlyArray<string>,
	): Promise<{ stdout: string; stderr: string; outputPath: string; inputPath: string; written: StatsFigures }> => {
		const inputPath = join(workingDirectory, `${name}.wav`);
		const outputPath = join(workingDirectory, `${name}-out.wav`);

		await writeTestWav(inputPath, channels, { bitDepth: "32f" });

		const run = await runCli(["target", inputPath, "-o", outputPath, ...options]);

		expect(run.exitCode).toBeUndefined();

		return {
			stdout: run.stdout.toString("utf8"),
			stderr: run.stderr,
			outputPath,
			inputPath,
			written: await statsOf(outputPath),
		};
	};

	const expectLanded = (figure: number | null, target: number): void => {
		expect(figure).not.toBeNull();
		expect(figure ?? Infinity).toBeLessThanOrEqual(target + GRAIN);
		expect(Math.abs((figure ?? Infinity) - target)).toBeLessThan(TOLERANCE);
	};

	it("lands -60 dBFS noise too short for a short-term window on --lufs -16", async () => {
		const noise = scaled(createNoise(2 * SAMPLE_RATE, 1, 11), dbToLinear(-60) / NOISE_RMS);
		const { written } = await runTarget("noise", noise, ["--lufs", "-16"]);

		expectLanded(written.integratedLufs, -16);
	}, 60_000);

	it("lands a -20 dBFS sine on both targets with the peak arm off", async () => {
		const sine = createSine(10 * SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-20));
		const { stdout, written } = await runTarget("sine", sine, ["--lufs", "-16", "--tp", "-1"]);

		expectLanded(written.integratedLufs, -16);
		expect(written.truePeakDb ?? Infinity).toBeLessThanOrEqual(-1 + GRAIN);
		expect(stdout).toMatch(/^peak gain \(before ceiling\) +n\/a$/m);
	}, 60_000);

	it("gives a dense loud passage and a quiet one the same gain", async () => {
		const loudSeconds = 9;
		const frameCount = 10 * SAMPLE_RATE;
		const toneAmplitude = dbToLinear(-0.3) / 3;
		const channel = new Float64Array(frameCount);

		for (let index = 0; index < frameCount; index++) {
			const time = index / SAMPLE_RATE;
			const level = time < loudSeconds ? toneAmplitude : toneAmplitude * dbToLinear(-12);

			channel[index] =
				level *
				(Math.sin(2 * Math.PI * 220 * time) +
					Math.sin(2 * Math.PI * 550 * time) +
					Math.sin(2 * Math.PI * 1400 * time));
		}

		const { inputPath, outputPath } = await runTarget("dense", [channel], ["--lufs", "-16", "--tp", "-1"]);
		const [input = new Float64Array(0)] = await decodedSamplesOf(inputPath);
		const [output = new Float64Array(0)] = await decodedSamplesOf(outputPath);
		const gainDbOver = (startSeconds: number, endSeconds: number): number => {
			const start = Math.round(startSeconds * SAMPLE_RATE);
			const end = Math.round(endSeconds * SAMPLE_RATE);

			return rmsDbOf(output, start, end) - rmsDbOf(input, start, end);
		};

		expect(Math.abs(gainDbOver(2, 7) - gainDbOver(9.3, 9.8))).toBeLessThan(0.5);
	}, 60_000);

	it("leaves the room tone around a click between speech-like bursts at unity", async () => {
		const frameCount = 12 * SAMPLE_RATE;
		const [roomTone = new Float64Array(0)] = scaled(createNoise(frameCount, 1, 23), dbToLinear(-60) / NOISE_RMS);
		const channel = Float64Array.from(roomTone);
		const burstAmplitude = dbToLinear(-25);
		const burstFrames = Math.round(0.4 * SAMPLE_RATE);
		const rampFrames = Math.round(0.02 * SAMPLE_RATE);
		const gapStart = 5 * SAMPLE_RATE;
		const gapEnd = 7.5 * SAMPLE_RATE;
		const clickFrame = 6.25 * SAMPLE_RATE;

		for (let burstStart = 0; burstStart + burstFrames <= frameCount; burstStart += Math.round(0.7 * SAMPLE_RATE)) {
			if (burstStart + burstFrames > gapStart && burstStart < gapEnd) {
				continue;
			}

			for (let offset = 0; offset < burstFrames; offset++) {
				const edge = Math.min(offset, burstFrames - 1 - offset);
				const ramp = edge < rampFrames ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / rampFrames) : 1;
				const index = burstStart + offset;

				channel[index] =
					(channel[index] ?? 0) + burstAmplitude * ramp * Math.sin((2 * Math.PI * 1000 * index) / SAMPLE_RATE);
			}
		}

		channel[clickFrame] = dbToLinear(-10);

		const { inputPath, outputPath } = await runTarget("click", [channel], ["--lufs", "-16", "--tp", "-1"]);
		const [input = new Float64Array(0)] = await decodedSamplesOf(inputPath);
		const [output = new Float64Array(0)] = await decodedSamplesOf(outputPath);
		const windowFrames = Math.round(0.02 * SAMPLE_RATE);

		for (let start = clickFrame - 15 * windowFrames; start < clickFrame + 15 * windowFrames; start += windowFrames) {
			expect(
				Math.abs(rmsDbOf(output, start, start + windowFrames) - rmsDbOf(input, start, start + windowFrames)),
			).toBeLessThan(0.05);
		}
	}, 60_000);

	const expectSpeechLikeFit = async (args: {
		readonly name: string;
		readonly speech: SpeechLike;
		readonly options: ReadonlyArray<string>;
		readonly tolerance: number;
	}): Promise<string> => {
		const { name, speech, options, tolerance } = args;
		const { stdout, stderr, inputPath, outputPath, written } = await runTarget(name, [speech.channel], options);
		const [input = new Float64Array(0)] = await decodedSamplesOf(inputPath);
		const [output = new Float64Array(0)] = await decodedSamplesOf(outputPath);
		const background = largestBackgroundGainDbOf(speech, input, output, SAMPLE_RATE);
		const writtenLufs = written.integratedLufs ?? Infinity;
		const unreachable = UNREACHABLE_PATTERN.exec(stderr)?.[1];

		expect(background.windows).toBeGreaterThan(20);
		expect(background.largestDb).toBeLessThan(1);
		expect(writtenLufs).toBeLessThanOrEqual(-16 + GRAIN);

		if (unreachable === undefined) {
			expect(Math.abs(writtenLufs + 16)).toBeLessThan(tolerance);
		} else {
			expect(Math.abs(Number(unreachable) - writtenLufs)).toBeLessThanOrEqual(0.005 + 1e-9);
			expect(printedFigureOf(stdout, "output integrated")).toBe(Number(unreachable));
			expect(writtenLufs).toBeLessThanOrEqual(-16 - tolerance + GRAIN);
		}

		return stderr;
	};

	it("stops at the body's saturation on speech with a cough under --lufs alone, leaving the room tone at unity", async () => {
		const speech = createSpeechLike({
			seconds: 9,
			sampleRate: SAMPLE_RATE,
			roomToneDb: -95,
			syllableDb: [-50, -24],
			spike: { aboveDb: -30, db: -4 },
			coughDb: -14,
			seed: 5,
		});
		const stderr = await expectSpeechLikeFit({
			name: "cough-lufs",
			speech,
			options: ["--lufs", "-16"],
			tolerance: TOLERANCE,
		});

		expect(stderr).toMatch(UNREACHABLE_PATTERN);
	}, 60_000);

	it("stops at the body's saturation on speech with a cough under both targets, leaving the room tone at unity", async () => {
		const speech = createSpeechLike({
			seconds: 9,
			sampleRate: SAMPLE_RATE,
			roomToneDb: -77,
			syllableDb: [-55, -28],
			spike: { aboveDb: -34, db: -6 },
			coughDb: -12,
			seed: 3,
		});
		const stderr = await expectSpeechLikeFit({
			name: "cough-both",
			speech,
			options: ["--lufs", "-16", "--tp", "-1"],
			tolerance: TOLERANCE,
		});

		expect(stderr).toMatch(UNREACHABLE_PATTERN);
	}, 60_000);

	it("ends at or under --lufs on quiet speech over room tone whose attempts land over the target", async () => {
		const speech = createSpeechLike({
			seconds: 9,
			sampleRate: SAMPLE_RATE,
			roomToneDb: -82,
			syllableDb: [-76, -57],
			spike: null,
			coughDb: null,
			seed: 1,
		});
		const stderr = await expectSpeechLikeFit({
			name: "room-tone",
			speech,
			options: ["--lufs", "-16", "--tp", "-1", "--floor", "-71", "--pivot", "-61", "--tolerance", "0.1"],
			tolerance: 0.1,
		});

		expect(stderr).toMatch(/^attempt 2 .*loudness error 0\.\d+/m);
	}, 120_000);

	it("lands a loud source on --lufs -50", async () => {
		const noise = scaled(createNoise(5 * SAMPLE_RATE, 2, 31), dbToLinear(-10) / NOISE_RMS);
		const { written } = await runTarget("loud", noise, ["--lufs", "-50", "--tp", "-1"]);

		expectLanded(written.integratedLufs, -50);
	}, 60_000);

	it("lands the true peak on --tp -1 alone", async () => {
		const sine = createSine(5 * SAMPLE_RATE, 2, SAMPLE_RATE, 997, dbToLinear(-20));
		const { written } = await runTarget("tp-only", sine, ["--tp", "-1"]);

		expectLanded(written.truePeakDb, -1);
	}, 60_000);

	it("holds 0 dBTP under --lufs alone on noise carrying full-scale pulses", async () => {
		const [noise = new Float64Array(0)] = scaled(createNoise(10 * SAMPLE_RATE, 1, 41), dbToLinear(-26) / NOISE_RMS);
		const pulsePeriod = Math.round(0.0685 * SAMPLE_RATE);

		for (let index = pulsePeriod; index < noise.length; index += pulsePeriod) {
			noise[index] = 1;
		}

		const { written } = await runTarget("pulses", [noise], ["--lufs", "-16"]);

		expect(written.truePeakDb ?? Infinity).toBeLessThanOrEqual(GRAIN);
	}, 60_000);

	it("prints the figures of the 8-bit file it wrote", async () => {
		const inputPath = join(workingDirectory, "eight-bit.wav");
		const outputPath = join(workingDirectory, "eight-bit-out.raw");

		await writeTestWav(inputPath, createSine(5 * SAMPLE_RATE, 1, SAMPLE_RATE, 997, dbToLinear(-6)), {
			bitDepth: "32f",
		});

		const run = await runCli(["target", inputPath, "-f", "u8", "-o", outputPath, "--lufs", "-35"]);
		const statsRun = await runCli([
			"stats",
			"--json",
			"-f",
			"u8",
			"-ar",
			String(SAMPLE_RATE),
			"-ac",
			"1",
			outputPath,
		]);
		const [written] = JSON.parse(statsRun.stdout.toString("utf8")) as Array<StatsFigures>;
		const stdout = run.stdout.toString("utf8");

		expect(run.exitCode).toBeUndefined();

		for (const [label, figure] of [
			["output integrated", written?.integratedLufs ?? null],
			["output true peak", written?.truePeakDb ?? null],
			["loudness range", written?.loudnessRange ?? null],
		] as const) {
			const printed = printedFigureOf(stdout, label);

			expect(printed === null).toBe(figure === null);
			expect(Math.abs((printed ?? 0) - (figure ?? 0))).toBeLessThanOrEqual(0.005 + 1e-9);
		}
	}, 60_000);
});
