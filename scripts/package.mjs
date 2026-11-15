// Builds the release files for the machine it runs on into out/make: the standalone executable compiled by Bun, and on
// Windows the NSIS installer that carries it. THIRD-PARTY-NOTICES.txt goes beside them and into the installer.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionOf } from "./release.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));

// The x64 builds take Bun's baseline runtime, which runs on x64 processors without AVX2.
export const platforms = {
	"win32-x64": {
		platform: "windows-x64",
		extension: ".exe",
		installerArch: "x64",
		bunTarget: "bun-windows-x64-baseline",
	},
	"win32-arm64": { platform: "windows-arm64", extension: ".exe", installerArch: "arm64" },
	"linux-x64": { platform: "linux-x64", extension: "", bunTarget: "bun-linux-x64-baseline" },
	"linux-arm64": { platform: "linux-arm64", extension: "" },
	"darwin-arm64": { platform: "mac-arm64", extension: "" },
	"darwin-x64": { platform: "mac-x64", extension: "", bunTarget: "bun-darwin-x64-baseline" },
};

export function hostPlatformOf(platform = process.platform, arch = process.arch) {
	const key = `${platform}-${arch}`;

	if (!Object.hasOwn(platforms, key))
		throw new Error(
			`No release platform for ${key}; scripts/package.mjs builds ${Object.keys(platforms).join(", ")}`,
		);

	return platforms[key];
}

export function releaseFileNamesOf(version, { platform, extension, installerArch }) {
	return {
		binary: `loudness-tool-${version}-${platform}${extension}`,
		installer: installerArch === undefined ? undefined : `loudness-tool-${version}-${platform}-setup.exe`,
	};
}

// packaging/bun-LICENSE.txt is Bun's LICENSE.md at the tag of the pinned Bun version; the two change together.
const bunVersionOf = (directory) =>
	JSON.parse(readFileSync(join(directory, "node_modules", "bun", "package.json"), "utf8")).version;

// The executable embeds each production dependency and the Bun runtime, so their licences ship beside it.
export function noticesOf(directory) {
	const lock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8"));
	const sections = Object.entries(lock.packages)
		.filter(([path, entry]) => path.startsWith("node_modules/") && entry.dev !== true)
		.map(([path, entry]) => {
			const licence = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"]
				.map((name) => join(directory, path, name))
				.find((candidate) => existsSync(candidate));

			if (licence === undefined) throw new Error(`${path} carries no licence file`);

			return `${path.slice("node_modules/".length)} ${entry.version} (${entry.license})\n\n${readFileSync(licence, "utf8").trim()}\n`;
		});

	return [
		"loudness-tool embeds the following software.",
		...sections,
		`Bun ${bunVersionOf(directory)}, compiled into the executable\n\n${readFileSync(join(directory, "packaging", "bun-LICENSE.txt"), "utf8").trim()}\n`,
	].join("\n\n");
}

function run(command, arguments_) {
	const result = spawnSync(command, arguments_, { cwd: root, stdio: "inherit" });

	if (result.error !== undefined) throw result.error;

	if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`);
}

// MAKENSIS, then the portable NSIS 3.13 in .tools, then makensis on PATH.
function makensisOf() {
	if (process.env.MAKENSIS) return process.env.MAKENSIS;

	const portable = join(root, ".tools", "nsis", "nsis-3.13", "makensis.exe");

	return existsSync(portable) ? portable : "makensis";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const version = versionOf();
	const host = hostPlatformOf();
	const names = releaseFileNamesOf(version, host);
	const output = join(root, "out", "make");
	const binary = join(output, names.binary);
	const notices = join(output, "THIRD-PARTY-NOTICES.txt");
	const bun = join(dirname(require.resolve("bun/package.json")), "bin", "bun.exe");

	mkdirSync(output, { recursive: true });
	writeFileSync(notices, noticesOf(root));
	run(bun, [
		"build",
		"--compile",
		"--minify",
		...(host.bunTarget === undefined ? [] : [`--target=${host.bunTarget}`]),
		...(host.installerArch === undefined
			? []
			: [
					"--windows-title=loudness-tool",
					"--windows-publisher=Matt Cavender",
					`--windows-version=${version}.0`,
					"--windows-description=WAV and raw PCM loudness processing",
					"--windows-copyright=Copyright (c) Matt Cavender, MIT License",
				]),
		"--outfile",
		binary,
		"src/main.ts",
	]);
	console.log(binary);

	if (names.installer !== undefined) {
		const installer = join(output, names.installer);

		run(makensisOf(), [
			"/V2",
			`/DVERSION=${version}`,
			`/DARCH=${host.installerArch}`,
			`/DBINARY=${binary}`,
			`/DNOTICES=${notices}`,
			`/DLICENSE=${join(root, "LICENSE")}`,
			`/DOUTFILE=${installer}`,
			join(root, "packaging", "installer.nsi"),
		]);
		console.log(installer);
	}
}
