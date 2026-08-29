import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

export const copyUnchanged = async (inputPath: string, outputPath: string): Promise<void> => {
	if (resolve(inputPath) === resolve(outputPath)) {
		return;
	}

	await copyFile(inputPath, outputPath);
};
