import type { WavSink } from "../../wav/WavWriter";

const STDOUT_PATH = "-";

export const sinkOf = (output: string): WavSink =>
	output === STDOUT_PATH ? { kind: "stream", stream: process.stdout } : { kind: "file", path: output };

export const summaryStreamOf = (output: string): NodeJS.WritableStream =>
	output === STDOUT_PATH ? process.stderr : process.stdout;
