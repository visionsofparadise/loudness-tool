import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, vi } from "vitest";
import { runProgram } from "../cli";
import { WavReader } from "../wav/WavReader";
import { WavWriter } from "../wav/WavWriter";
import type { SourceBitDepth } from "../wav/utils/wavFormat";

interface CliRun {
	readonly stdout: Buffer;
	readonly stderr: string;
	readonly stderrBytes: Buffer;
	readonly exitCode: string | number | null | undefined;
}

export const captureWrites =
	(onChunk: (chunk: Buffer) => void) =>
	(chunk: string | Uint8Array, ...rest: Array<unknown>): boolean => {
		onChunk(Buffer.from(chunk));

		const callback = rest.find((argument) => typeof argument === "function");

		if (typeof callback === "function") {
			process.nextTick(callback);
		}

		return true;
	};

export const runCli = async (argv: ReadonlyArray<string>, stdin?: Buffer): Promise<CliRun> => {
	const stdoutChunks: Array<Buffer> = [];
	const stderrChunks: Array<Buffer> = [];
	const stdinStream = new PassThrough();
	const stdinSpy = vi.spyOn(process, "stdin", "get").mockReturnValue(stdinStream as unknown as typeof process.stdin);
	const stdoutSpy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation(captureWrites((chunk) => stdoutChunks.push(chunk)));
	const stderrSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation(captureWrites((chunk) => stderrChunks.push(chunk)));
	const previousExitCode = process.exitCode;

	process.exitCode = undefined;
	stdinStream.end(stdin ?? Buffer.alloc(0));

	try {
		await runProgram(["node", "loudness-tool", ...argv]);

		return {
			stdout: Buffer.concat(stdoutChunks),
			stderr: Buffer.concat(stderrChunks).toString("utf8"),
			stderrBytes: Buffer.concat(stderrChunks),
			exitCode: process.exitCode,
		};
	} finally {
		stdinSpy.mockRestore();
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		process.exitCode = previousExitCode;
	}
};

export const runStdioCombinations = async (args: {
	readonly command: ReadonlyArray<string>;
	readonly inputPath: string;
	readonly directory: string;
}): Promise<{
	readonly fileOutput: Buffer;
	readonly fileRun: CliRun;
	readonly stdinOutput: Buffer;
	readonly stdinRun: CliRun;
	readonly stdoutRun: CliRun;
	readonly pipeRun: CliRun;
	readonly summaryFor: (output: string) => string;
	readonly stdinPath: string;
}> => {
	const { command, inputPath, directory } = args;
	const [name = "", ...options] = command;
	const input = await readFile(inputPath);
	const filePath = join(directory, "stdio-file.wav");
	const stdinPath = join(directory, "stdio-stdin.wav");
	const fileRun = await runCli([name, inputPath, "-o", filePath, ...options]);
	const stdinRun = await runCli([name, "-", "-o", stdinPath, ...options], input);
	const stdoutRun = await runCli([name, inputPath, "-o", "-", ...options]);
	const pipeRun = await runCli([name, "-", "-o", "-", ...options], input);

	return {
		fileOutput: await readFile(filePath),
		fileRun,
		stdinOutput: await readFile(stdinPath),
		stdinRun,
		stdoutRun,
		pipeRun,
		summaryFor: (output) => fileRun.stdout.toString("utf8").replace(filePath, output),
		stdinPath,
	};
};

export const decodedSamplesOf = async (path: string): Promise<Array<Float64Array>> => {
	const reader = await WavReader.open(path);
	const channels = Array.from(
		{ length: reader.format.channelCount },
		() => new Float64Array(reader.format.frameCount),
	);

	try {
		for await (const block of reader.blocks()) {
			block.channels.forEach((channel, channelIndex) => channels[channelIndex]?.set(channel, block.frameIndex));
		}
	} finally {
		await reader.close();
	}

	return channels;
};

export const runSilenceOnStdin = async (args: {
	readonly command: ReadonlyArray<string>;
	readonly inputPath: string;
	readonly directory: string;
}): Promise<{
	readonly inputSamples: Array<Float64Array>;
	readonly fileSamples: Array<Float64Array>;
	readonly pipeSamples: Array<Float64Array>;
	readonly fileRun: CliRun;
	readonly pipeRun: CliRun;
}> => {
	const { command, inputPath, directory } = args;
	const [name = "", ...options] = command;
	const input = await readFile(inputPath);
	const filePath = join(directory, "silence-stdin.wav");
	const pipePath = join(directory, "silence-pipe.wav");
	const fileRun = await runCli([name, "-", "-o", filePath, ...options], input);
	const pipeRun = await runCli([name, "-", "-o", "-", ...options], input);

	await writeFile(pipePath, pipeRun.stdout);

	return {
		inputSamples: await decodedSamplesOf(inputPath),
		fileSamples: await decodedSamplesOf(filePath),
		pipeSamples: await decodedSamplesOf(pipePath),
		fileRun,
		pipeRun,
	};
};

export const writeTestWav = async (
	path: string,
	channels: ReadonlyArray<Float64Array>,
	format: { readonly bitDepth: SourceBitDepth; readonly channelMask?: number; readonly sampleRate?: number },
): Promise<void> => {
	const writer = await WavWriter.create(
		{ kind: "file", path },
		{
			sampleRate: format.sampleRate ?? 48000,
			channelCount: channels.length,
			channelMask: format.channelMask ?? 0,
			bitDepth: format.bitDepth,
			frameCount: channels[0]?.length ?? 0,
		},
	);

	await writer.write(channels);
	await writer.close();
};

export const dataBytesOf = async (path: string): Promise<Buffer> => {
	const reader = await WavReader.open(path);
	const { dataOffset, blockAlign } = reader;
	const { frameCount } = reader.format;

	await reader.close();

	return (await readFile(path)).subarray(dataOffset, dataOffset + frameCount * blockAlign);
};

export const expectRawMatchesFileMode = async (args: {
	readonly command: ReadonlyArray<string>;
	readonly inputPath: string;
	readonly directory: string;
}): Promise<void> => {
	const { command, inputPath, directory } = args;
	const [name = "", ...options] = command;
	const raw = ["-f", "s24le", "-ar", "48000", "-ac", "2"];
	const filePath = join(directory, "raw-file-mode.wav");
	const rawPath = join(directory, "raw-input.raw");
	const rawOutputPath = join(directory, "raw-file-output.wav");
	const fileRun = await runCli([name, inputPath, "-o", filePath, ...options]);
	const rawData = await dataBytesOf(inputPath);

	await writeFile(rawPath, rawData);

	const pipeRun = await runCli([name, ...raw, "-", "-f", "s24le", "-o", "-", ...options], rawData);
	const rawFileRun = await runCli([name, ...raw, rawPath, "-o", rawOutputPath, ...options]);
	const summary = fileRun.stdout.toString("utf8").replace(filePath, "-");

	expect([fileRun.exitCode, pipeRun.exitCode, rawFileRun.exitCode]).toEqual([undefined, undefined, undefined]);
	expect(pipeRun.stdout.equals(await dataBytesOf(filePath))).toBe(true);
	expect(pipeRun.stdout.length).toBeGreaterThan(0);
	expect(pipeRun.stderr).toBe(`${fileRun.stderr}${summary}`);
	expect(pipeRun.stderr).toMatch(/\noutput {4,}-\n$/);
	expect(await decodedSamplesOf(rawOutputPath)).toEqual(await decodedSamplesOf(filePath));
};
