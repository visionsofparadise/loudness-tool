#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CommanderError, Command } from "commander";
import { addLufsNormCommand } from "./commands/lufsNorm";
import { addStatsCommand } from "./commands/stats";
import { addTpNormCommand } from "./commands/tpNorm";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	version: string;
};

export const createProgram = (): Command => {
	const program = new Command();

	program.name("loudness-tool").description("WAV loudness processing").version(packageJson.version);

	addStatsCommand(program);
	addTpNormCommand(program);
	addLufsNormCommand(program);

	return program;
};

export const runProgram = async (argv: Array<string>): Promise<void> => {
	const program = createProgram();

	program.exitOverride();

	try {
		await program.parseAsync(argv);
	} catch (error: unknown) {
		if (error instanceof CommanderError) {
			if (error.exitCode !== 0) {
				process.exitCode = error.exitCode;
			}

			return;
		}

		const message = error instanceof Error ? error.message : String(error);

		process.stderr.write(`error: ${message}\n`);
		process.exitCode = 1;
	}
};

const entryPath = process.argv[1];

if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
	void runProgram(process.argv);
}
