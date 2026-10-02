import { STDIO_PATH } from "./stdioPath";
import type { WavSink } from "../../wav/WavWriter";

export const sinkOf = (output: string): WavSink =>
	output === STDIO_PATH ? { kind: "stream", stream: process.stdout } : { kind: "file", path: output };

export const summaryStreamOf = (output: string): NodeJS.WritableStream =>
	output === STDIO_PATH ? process.stderr : process.stdout;
