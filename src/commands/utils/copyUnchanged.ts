import { randomBytes } from "node:crypto";
import { copyFile, open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { writeToStream } from "../../utils/writeToStream";
import type { WavSink } from "../../wav/WavWriter";

const COPY_CHUNK_BYTES = 1 << 20;

const copyToFile = async (replayPath: string, outputPath: string): Promise<void> => {
	if (resolve(replayPath) === resolve(outputPath)) {
		return;
	}

	const temporaryPath = `${outputPath}.${randomBytes(8).toString("hex")}.tmp`;

	try {
		await copyFile(replayPath, temporaryPath);
		await rename(temporaryPath, outputPath);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);

		throw error;
	}
};

const copyToStream = async (replayPath: string, stream: NodeJS.WritableStream): Promise<void> => {
	const fileHandle = await open(replayPath, "r");

	try {
		for (;;) {
			const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
			const { bytesRead } = await fileHandle.read(buffer, 0, COPY_CHUNK_BYTES, null);

			if (bytesRead === 0) {
				return;
			}

			await writeToStream(stream, buffer.subarray(0, bytesRead));
		}
	} finally {
		await fileHandle.close();
	}
};

export const copyUnchanged = async (replayPath: string, sink: WavSink): Promise<void> =>
	sink.kind === "file" ? copyToFile(replayPath, sink.path) : copyToStream(replayPath, sink.stream);
