import { randomBytes } from "node:crypto";
import { copyFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";

export const copyUnchanged = async (inputPath: string, outputPath: string): Promise<void> => {
	if (resolve(inputPath) === resolve(outputPath)) {
		return;
	}

	const temporaryPath = `${outputPath}.${randomBytes(8).toString("hex")}.tmp`;

	try {
		await copyFile(inputPath, temporaryPath);
		await rename(temporaryPath, outputPath);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);

		throw error;
	}
};
