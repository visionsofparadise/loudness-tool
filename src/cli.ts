#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { addConvertCommand } from "./commands/convert";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	version: string;
};

export const createProgram = (): Command => {
	const program = new Command();

	program.name("loudness-tool").description("WAV loudness processing").version(packageJson.version);

	addConvertCommand(program);

	return program;
};

const entryPath = process.argv[1];

if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
	void createProgram()
		.parseAsync(process.argv)
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);

			process.stderr.write(`error: ${message}\n`);
			process.exit(1);
		});
}
