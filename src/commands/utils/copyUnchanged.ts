import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { sinkOutputOf, type WavSink } from "../../wav/WavWriter";

const COPY_CHUNK_BYTES = 1 << 20;

export const copyUnchanged = async (replayPath: string, sink: WavSink): Promise<void> => {
	if (sink.kind === "file" && resolve(replayPath) === resolve(sink.path)) {
		return;
	}

	const output = await sinkOutputOf(sink);

	try {
		const fileHandle = await open(replayPath, "r");

		try {
			for (let position = 0; ;) {
				const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
				const { bytesRead } = await fileHandle.read(buffer, 0, COPY_CHUNK_BYTES, null);

				if (bytesRead === 0) {
					break;
				}

				await output.write(buffer.subarray(0, bytesRead), position);

				position += bytesRead;
			}
		} finally {
			await fileHandle.close();
		}

		await output.commit();
	} finally {
		await output.discard();
	}
};
