import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import { runProgram } from "../cli";
import { WavReader } from "../wav/WavReader";

interface CliRun {
	readonly stdout: Buffer;
	readonly stderr: string;
	readonly exitCode: string | number | null | undefined;
}

const capture =
	(chunks: Array<Buffer>) =>
	(chunk: string | Uint8Array, ...rest: Array<unknown>): boolean => {
		chunks.push(Buffer.from(chunk));

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
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(capture(stdoutChunks));
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(capture(stderrChunks));
	const previousExitCode = process.exitCode;

	process.exitCode = undefined;
	stdinStream.end(stdin ?? Buffer.alloc(0));

	try {
		await runProgram(["node", "loudness-tool", ...argv]);

		return {
			stdout: Buffer.concat(stdoutChunks),
			stderr: Buffer.concat(stderrChunks).toString("utf8"),
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
