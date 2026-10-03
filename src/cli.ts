#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CommanderError, type Command } from "commander";
import { addCrestCommand } from "./commands/crest";
import { addLufsNormCommand } from "./commands/lufsNorm";
import { addStatsCommand } from "./commands/stats";
import { addTargetCommand } from "./commands/target";
import { addTpNormCommand } from "./commands/tpNorm";
import { AudioProgram } from "./commands/utils/AudioProgram";
import { STREAM_OPTIONS_HELP } from "./commands/utils/streamOptions";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	version: string;
};

export const createProgram = (): Command => {
	const program = new AudioProgram();

	program
		.name("loudness-tool")
		.description("WAV and raw PCM loudness processing")
		.version(packageJson.version)
		.configureHelp({ showGlobalOptions: true });
	program.option("--scratch-dir <path>", "directory for temporary files");

	addStatsCommand(program);
	addTpNormCommand(program);
	addLufsNormCommand(program);
	addTargetCommand(program);
	addCrestCommand(program);

	for (const command of program.commands) {
		command.addHelpText("after", STREAM_OPTIONS_HELP);
	}

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
