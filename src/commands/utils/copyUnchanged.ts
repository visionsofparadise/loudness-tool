import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { bytesPerSampleOf } from "../../wav/utils/sampleCodec";
import { wavHeaderOf } from "../../wav/utils/wavHeader";
import { WavReader } from "../../wav/WavReader";
import { sinkOutputOf, type WavSink } from "../../wav/WavWriter";
import { applyUniformGain } from "./applyUniformGain";
import type { AudioOutput } from "./sinks";

const COPY_CHUNK_BYTES = 1 << 20;

const copyBytes = async (
	replayPath: string,
	sink: WavSink,
	range: { readonly header: Buffer; readonly start: number; readonly length: number },
): Promise<void> => {
	const output = await sinkOutputOf(sink);

	try {
		const fileHandle = await open(replayPath, "r");

		try {
			if (range.header.length > 0) {
				await output.write(range.header, 0);
			}

			for (let copied = 0; copied < range.length;) {
				const buffer = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, range.length - copied));
				const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, range.start + copied);

				if (bytesRead === 0) {
					break;
				}

				await output.write(buffer.subarray(0, bytesRead), range.header.length + copied);

				copied += bytesRead;
			}
		} finally {
			await fileHandle.close();
		}

		await output.commit();
	} finally {
		await output.discard();
	}
};

export const copyUnchanged = async (replayPath: string, output: AudioOutput): Promise<void> => {
	const { sink } = output;
	const reader = await WavReader.open(replayPath);
	const { format, dataOffset, blockAlign } = reader;

	await reader.close();

	const dataLength = format.frameCount * blockAlign;
	const isUnpadded = blockAlign === format.channelCount * bytesPerSampleOf(format.bitDepth);

	if (output.container === "wav" && output.channelMask === format.channelMask) {
		if (sink.kind === "file" && resolve(replayPath) === resolve(sink.path)) {
			return;
		}

		await copyBytes(replayPath, sink, { header: Buffer.alloc(0), start: 0, length: Number.POSITIVE_INFINITY });
	} else if (output.container === "wav") {
		await copyBytes(replayPath, sink, {
			header: wavHeaderOf({ ...format, channelMask: output.channelMask, blockAlign }, dataLength),
			start: dataOffset,
			length: dataLength,
		});
	} else if (output.bitDepth === format.bitDepth && isUnpadded) {
		await copyBytes(replayPath, sink, { header: Buffer.alloc(0), start: dataOffset, length: dataLength });
	} else {
		await applyUniformGain(replayPath, output, 1);
	}
};
