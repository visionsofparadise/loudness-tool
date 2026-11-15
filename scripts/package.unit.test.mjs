import { describe, expect, it } from "vitest";
import { platforms, releaseFileNamesOf } from "./package.mjs";
import { artifactNamesOf } from "./release.mjs";

describe("scripts/package.mjs", () => {
	it("names every platform's files as the release expects", () => {
		const built = Object.values(platforms).flatMap((platform) => {
			const { binary, installer } = releaseFileNamesOf("0.2.0", platform);

			return installer === undefined ? [binary] : [binary, installer];
		});

		expect(built.sort()).toEqual(artifactNamesOf("0.2.0"));
	});
});
