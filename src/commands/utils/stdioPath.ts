import { createReadStream, createWriteStream } from "node:fs";

const PIPE_PREFIX = "pipe:";

export const descriptorOf = (path: string, direction: "input" | "output"): number | undefined => {
	if (path !== "-" && !path.startsWith(PIPE_PREFIX)) {
		return undefined;
	}

	const text = path === "-" ? "" : path.slice(PIPE_PREFIX.length);

	if (text === "") {
		return direction === "input" ? 0 : 1;
	}

	if (!/^[ \t\n\v\f\r]*[+-]?\d+$/.test(text)) {
		throw new Error(`Cannot open "${path}": a pipe is pipe: or pipe:<file descriptor>`);
	}

	const descriptor = Number(text.trim());

	if (descriptor < 0) {
		throw new Error(`Cannot open "${path}": a file descriptor is 0 or more`);
	}

	return descriptor;
};

export const readableOf = (descriptor: number): NodeJS.ReadableStream =>
	descriptor === 0 ? process.stdin : createReadStream("", { fd: descriptor, autoClose: false });

export const writableOf = (descriptor: number): NodeJS.WritableStream => {
	switch (descriptor) {
		case 1:
			return process.stdout;
		case 2:
			return process.stderr;
		default:
			return createWriteStream("", { fd: descriptor, autoClose: false });
	}
};
