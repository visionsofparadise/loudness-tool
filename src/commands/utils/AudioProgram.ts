import { Command, type ParseOptionsResult } from "commander";
import { DEFAULT_STREAM_OPTIONS, scopeStreamArguments, type StreamScopes } from "./streamOptions";

const scopesByCommand = new WeakMap<Command, StreamScopes>();

export class AudioProgram extends Command {
	override parseOptions(argv: Array<string>): ParseOptionsResult {
		const scoped = scopeStreamArguments(argv, this);

		if (scoped.command !== undefined) {
			scopesByCommand.set(scoped.command, scoped.scopes);
		}

		for (const warning of scoped.warnings) {
			process.stderr.write(`warning: ${warning}\n`);
		}

		return super.parseOptions(scoped.args);
	}
}

export const streamScopesOf = (command: Command): StreamScopes =>
	scopesByCommand.get(command) ?? { inputs: [], output: DEFAULT_STREAM_OPTIONS };
