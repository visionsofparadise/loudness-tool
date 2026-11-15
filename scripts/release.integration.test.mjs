import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishRelease, releaseAssetNamesOf, versionOf, writeChecksums } from "./release.mjs";

const directories = [];
const sha = "a".repeat(40);
const other = "b".repeat(40);

const scratchDirectory = (prefix) => {
	const scratch = resolve(".scratch");

	mkdirSync(scratch, { recursive: true });

	const directory = mkdtempSync(join(scratch, prefix));

	directories.push(directory);

	return directory;
};

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

const fixture = ({ release = null, target = null, failure = null, corrupt = false } = {}) => {
	const directory = scratchDirectory("release-test-");
	const asset = "loudness-tool-0.1.0-windows-x64-setup.exe";

	for (const name of releaseAssetNamesOf("0.1.0")) writeFileSync(join(directory, name), `test release bytes: ${name}`);

	writeChecksums(directory, "0.1.0");

	const calls = [];
	const run = (arguments_) => {
		calls.push(arguments_);

		const [command, action] = arguments_;

		if (command === "api") {
			if (failure) throw failure;

			const result = action.includes("releases/tags")
				? release
				: target
					? { object: { type: "commit", sha: target } }
					: null;

			if (!result)
				throw Object.assign(new Error("HTTP 404"), {
					stdout: JSON.stringify({ status: "404", message: "Not Found" }),
				});

			return JSON.stringify(result);
		}

		if (action === "create") release = { draft: true, target_commitish: sha };

		if (action === "download") {
			const destination = arguments_[arguments_.indexOf("--dir") + 1];

			for (const name of releaseAssetNamesOf("0.1.0")) copyFileSync(join(directory, name), join(destination, name));

			copyFileSync(join(directory, "SHA256SUMS"), join(destination, "SHA256SUMS"));

			if (corrupt) writeFileSync(join(destination, asset), "corrupted");
		}

		if (action === "edit") target = sha;

		return "";
	};
	const publish = (draftOnly = false) =>
		publishRelease({ repository: "example/loudness-tool", sha, version: "0.1.0", directory, draftOnly, run });

	return { calls, publish, directory };
};

describe("scripts/release.mjs", () => {
	it("reads the version from package.json", () => {
		expect(versionOf()).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
	});

	it("publishes an absent version at the triggering commit, verifying the upload before publishing", () => {
		const { publish, calls } = fixture();

		expect(publish()).toBe("published");

		const create = calls.find((call) => call[1] === "create");

		expect(create[create.indexOf("--target") + 1]).toBe(sha);
		expect(calls.findIndex((call) => call[1] === "download")).toBeLessThan(
			calls.findIndex((call) => call[1] === "edit"),
		);
	});

	it("skips an already published version", () => {
		const { publish, calls } = fixture({ release: { draft: false }, target: other });

		expect(publish()).toBe("already published");
		expect(calls).toHaveLength(1);
	});

	it("recovers a matching incomplete draft by replacing and verifying every asset", () => {
		const { publish, calls } = fixture({ release: { draft: true, target_commitish: sha } });

		expect(publish()).toBe("published");
		expect(calls.some((call) => call[1] === "create")).toBe(false);
		expect(calls.find((call) => call[1] === "upload")).toContain("--clobber");
	});

	it("accepts an existing matching tag without a release", () => {
		expect(fixture({ target: sha }).publish()).toBe("published");
	});

	it("rejects a conflicting tag before remote writes", () => {
		const { publish, calls } = fixture({ target: other });

		expect(publish).toThrow(/another commit/u);
		expect(calls.every((call) => call[0] === "api")).toBe(true);
	});

	it("rejects a draft for another commit when no tag exists", () => {
		const { publish, calls } = fixture({ release: { draft: true, target_commitish: other } });

		expect(publish).toThrow(/another commit/u);
		expect(calls.every((call) => call[0] === "api")).toBe(true);
	});

	it("propagates API and network errors instead of reading them as missing releases", () => {
		for (const failure of [
			new Error("network unavailable"),
			Object.assign(new Error("HTTP 403"), { stdout: '{"status":"403","message":"Forbidden"}' }),
		]) {
			const { publish, calls } = fixture({ failure });

			expect(publish).toThrow(failure);
			expect(calls).toHaveLength(1);
		}
	});

	it("rejects invalid local checksums before API access", () => {
		const { publish, directory, calls } = fixture();

		writeFileSync(join(directory, "SHA256SUMS"), "wrong");
		expect(publish).toThrow(/checksum/u);
		expect(calls).toHaveLength(0);
	});

	it("leaves a draft unpublished when downloaded release bytes fail verification", () => {
		const { publish, calls } = fixture({ corrupt: true });

		expect(publish).toThrow(/checksum verification/u);
		expect(calls.some((call) => call[1] === "edit")).toBe(false);
	});

	it("rejects malformed versions without accessing files or running commands", () => {
		expect(() => publishRelease({ version: "../bad" })).toThrow(/version/u);
	});

	it("names the version, platform and architecture in every asset", () => {
		expect(releaseAssetNamesOf("0.2.0")).toEqual([
			"THIRD-PARTY-NOTICES.txt",
			"loudness-tool-0.2.0-linux-arm64",
			"loudness-tool-0.2.0-linux-x64",
			"loudness-tool-0.2.0-mac-arm64",
			"loudness-tool-0.2.0-mac-x64",
			"loudness-tool-0.2.0-windows-arm64-setup.exe",
			"loudness-tool-0.2.0-windows-arm64.exe",
			"loudness-tool-0.2.0-windows-x64-setup.exe",
			"loudness-tool-0.2.0-windows-x64.exe",
		]);
	});

	it("requires every platform asset before publishing", () => {
		const { publish, directory, calls } = fixture();

		rmSync(join(directory, "loudness-tool-0.1.0-mac-arm64"));
		expect(publish).toThrow(/ENOENT/u);
		expect(calls).toHaveLength(0);
	});

	it("uploads and verifies every platform asset and SHA256SUMS", () => {
		const { publish, calls, directory } = fixture();

		publish();

		const upload = calls.find((call) => call[1] === "upload");
		const download = calls.find((call) => call[1] === "download");

		for (const name of [...releaseAssetNamesOf("0.1.0"), "SHA256SUMS"]) {
			expect(upload).toContain(join(directory, name));
			expect(download).toContain(name);
		}
	});

	it("holds a verified draft for review and publishes it when the hold is removed", () => {
		const { publish, calls } = fixture();

		expect(publish(true)).toBe("draft ready for review");
		expect(calls.some((call) => call[1] === "edit")).toBe(false);
		expect(publish()).toBe("published");
		expect(calls.filter((call) => call[1] === "create")).toHaveLength(1);
	});
});
