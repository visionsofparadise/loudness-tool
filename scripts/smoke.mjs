#!/usr/bin/env node
// Runs a compiled loudness-tool executable beside the Node build in dist/main.js and fails unless every command exits the
// same way, prints the same text and figures, and writes the same audio. Bun and Node compute Math.sin, Math.log10 and
// Math.exp with different libraries that can disagree in the last bit, so a figure may differ by one unit in its last
// printed place, a full-precision figure by 1e-9 of its size, and up to one sample in 1000 by one step of an integer
// format or 1e-6 of full scale in a float one; whole numbers match exactly. Run npm run build first.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionOf } from "./release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const binaryPath = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
const nodeBuild = join(root, "dist", "main.js");

if (binaryPath === undefined || !existsSync(binaryPath)) {
	console.error(`Usage: node scripts/smoke.mjs <executable>; missing ${String(binaryPath)}`);
	process.exit(1);
}

if (!existsSync(nodeBuild)) {
	console.error(`missing ${nodeBuild}; run npm run build first`);
	process.exit(1);
}

// A 16-bit stereo WAV of tones whose level steps between quiet and loud, with a full-scale burst near half the sample
// rate so true peak, loudness gating and the target's peak handling all act.
const writeWav = (path) => {
	const sampleRate = 48000;
	const frames = sampleRate * 6;
	const data = Buffer.alloc(frames * 4);

	for (let frame = 0; frame < frames; frame++) {
		const seconds = frame / sampleRate;
		const level = Math.floor(seconds) % 2 === 0 ? 0.3 : 0.02;
		const burst = seconds > 4.5 && seconds < 4.6 ? 0.95 * Math.sin(2 * Math.PI * 0.4 * frame) : 0;
		const left = level * Math.sin(2 * Math.PI * 997 * seconds) + burst;
		const right = level * Math.sin(2 * Math.PI * 440 * seconds + 1) - burst;

		data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left * 32767))), frame * 4);
		data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right * 32767))), frame * 4 + 2);
	}

	const header = Buffer.alloc(44);

	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(2, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 4, 28);
	header.writeUInt16LE(4, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(data.length, 40);
	writeFileSync(path, Buffer.concat([header, data]));
};

mkdirSync(join(root, ".scratch"), { recursive: true });

const directory = mkdtempSync(join(root, ".scratch", "smoke-"));
const input = join(directory, "input.wav");

writeWav(input);

const NUMBER = /-?\d+(?:\.(\d+))?(?:e[-+]?\d+)?/giu;

const textDifferenceOf = (left, right) => {
	const leftWords = left.split(NUMBER);
	const rightWords = right.split(NUMBER);

	if (
		leftWords.filter((_, index) => index % 2 === 0).join("\u0000") !==
		rightWords.filter((_, index) => index % 2 === 0).join("\u0000")
	)
		return "text differs";

	const leftNumbers = [...left.matchAll(NUMBER)];
	const rightNumbers = [...right.matchAll(NUMBER)];

	for (let index = 0; index < leftNumbers.length; index++) {
		const [leftText, leftDecimals = ""] = leftNumbers[index];
		const [rightText, rightDecimals = ""] = rightNumbers[index];
		const decimals = Math.max(leftDecimals.length, rightDecimals.length);
		const leftValue = Number(leftText);
		const rightValue = Number(rightText);
		const lastPlace = decimals <= 6 ? 1.5 * 10 ** -decimals : 0;
		const tolerance = decimals === 0 ? 0 : Math.max(lastPlace, 1e-9 * Math.abs(leftValue));

		if (!(Math.abs(leftValue - rightValue) <= tolerance)) return `figure ${leftText} against node's ${rightText}`;
	}

	return undefined;
};

const wavLayoutOf = (buffer) => {
	let offset = 12;
	let format;

	while (offset + 8 <= buffer.length) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);

		if (id === "fmt ") {
			const tag = buffer.readUInt16LE(offset + 8);
			const bits = buffer.readUInt16LE(offset + 22);
			const subTag = tag === 0xfffe ? buffer.readUInt16LE(offset + 32) : tag;

			format = { float: subTag === 3, bits };
		}

		if (id === "data") return { ...format, dataOffset: offset + 8 };

		offset += 8 + size + (size % 2);
	}

	throw new Error("output carries no data chunk");
};

const samplesOf = (buffer, { float, bits }) => {
	const width = bits / 8;
	const count = Math.floor(buffer.length / width);
	const samples = new Float64Array(count);

	for (let index = 0; index < count; index++) {
		const at = index * width;

		if (float) samples[index] = bits === 32 ? buffer.readFloatLE(at) : buffer.readDoubleLE(at);
		else if (bits === 8) samples[index] = buffer.readUInt8(at) - 128;
		else samples[index] = buffer.readIntLE(at, width);
	}

	return samples;
};

// raw names a headerless format; otherwise the audio is a WAV file.
const audioDifferenceOf = (left, right, raw) => {
	if (left.length !== right.length) return `audio of ${left.length} bytes against node's ${right.length}`;

	const layout = raw ?? wavLayoutOf(left);
	const dataOffset = raw === undefined ? layout.dataOffset : 0;

	if (!left.subarray(0, dataOffset).equals(right.subarray(0, dataOffset))) return "WAV header differs from node's";

	const leftSamples = samplesOf(left.subarray(dataOffset), layout);
	const rightSamples = samplesOf(right.subarray(dataOffset), layout);
	const tolerance = layout.float ? 1e-6 : 1;
	let differing = 0;

	for (let index = 0; index < leftSamples.length; index++) {
		const difference = Math.abs(leftSamples[index] - rightSamples[index]);

		if (!(difference <= tolerance)) return `sample ${index} differs by ${difference}`;

		if (difference > 0) differing++;
	}

	if (differing > leftSamples.length / 1000) return `${differing} of ${leftSamples.length} samples differ`;

	if (differing > 0) console.log(`  ${differing} of ${leftSamples.length} samples differ within tolerance`);

	return undefined;
};

const run = (command, arguments_, stdin, cwd) =>
	spawnSync(command, arguments_, { cwd, input: stdin, maxBuffer: 1 << 28, timeout: 120_000 });

const checks = [
	{ name: "version", arguments: () => ["--version"], expectStdout: `${versionOf()}\n` },
	{ name: "help", arguments: () => ["--help"] },
	{ name: "stats", arguments: () => ["stats", "--json", input] },
	{ name: "stats at 16x", arguments: () => ["stats", "--json", "--oversampling", "16", input] },
	{ name: "tp-norm", arguments: (out) => ["tp-norm", input, "-o", out, "--tp", "-1"], output: true },
	{ name: "lufs-norm", arguments: (out) => ["lufs-norm", input, "-o", out, "--lufs", "-20"], output: true },
	{ name: "target", arguments: (out) => ["target", input, "-o", out, "--lufs", "-16", "--tp", "-1"], output: true },
	{ name: "crest", arguments: (out) => ["crest", input, "-o", out], output: true },
	{
		name: "pipe in and out",
		arguments: () => ["tp-norm", "-", "-o", "-", "--tp", "-2"],
		stdin: readFileSync(input),
		audioStdout: true,
	},
	{
		name: "raw pcm through pipes",
		arguments: () => [
			"lufs-norm",
			"-f",
			"s16le",
			"-ar",
			"48000",
			"-ac",
			"2",
			"-",
			"-f",
			"f32le",
			"-o",
			"-",
			"--lufs",
			"-23",
		],
		stdin: readFileSync(input).subarray(44),
		audioStdout: { float: true, bits: 32 },
	},
	{
		name: "in place",
		setup: (cwd) => copyFileSync(input, join(cwd, "output.wav")),
		arguments: (out) => ["target", out, "-o", out, "--tp", "-3"],
		output: true,
	},
	{ name: "missing input", arguments: () => ["stats", join(directory, "absent.wav")], expectFailure: true },
	{ name: "unknown option", arguments: () => ["stats", "--loud", input], expectFailure: true },
];

let failed = false;

try {
	for (const check of checks) {
		const results = [
			["executable", binaryPath, []],
			["node", process.execPath, [nodeBuild]],
		].map(([label, command, prefix]) => {
			// Each build writes the same relative path in its own folder, so the paths they print match.
			const cwd = join(directory, label, check.name.replaceAll(" ", "-"));
			const output = join(cwd, "output.wav");

			mkdirSync(cwd, { recursive: true });
			check.setup?.(cwd);

			const result = run(command, [...prefix, ...check.arguments("output.wav")], check.stdin, cwd);

			if (result.error !== undefined) throw new Error(`${check.name} (${label}): ${result.error.message}`);

			return {
				status: result.status,
				audio: result.stdout,
				stdout: result.stdout.toString("utf8"),
				stderr: result.stderr.toString("utf8"),
				written: check.output === true && existsSync(output) ? readFileSync(output) : undefined,
			};
		});
		const [executable, node] = results;
		const problems = [];

		if (executable.status !== node.status) problems.push(`exit ${executable.status} against node's ${node.status}`);
		const stdoutDifference =
			check.audioStdout === undefined
				? textDifferenceOf(executable.stdout, node.stdout)
				: audioDifferenceOf(
						executable.audio,
						node.audio,
						check.audioStdout === true ? undefined : check.audioStdout,
					);
		const stderrDifference = textDifferenceOf(executable.stderr, node.stderr);

		if (stdoutDifference !== undefined) problems.push(`stdout: ${stdoutDifference}`);
		if (stderrDifference !== undefined) problems.push(`stderr: ${stderrDifference}`);
		if (check.expectFailure === true ? executable.status === 0 : executable.status !== 0)
			problems.push(`exit ${executable.status}`);
		if (check.expectStdout !== undefined && executable.stdout !== check.expectStdout)
			problems.push(`stdout ${JSON.stringify(executable.stdout)}`);
		if (check.output === true && (executable.written === undefined || node.written === undefined))
			problems.push("no output file");
		if (executable.written !== undefined && node.written !== undefined) {
			const writtenDifference = audioDifferenceOf(executable.written, node.written, undefined);

			if (writtenDifference !== undefined) problems.push(`output file: ${writtenDifference}`);
		}

		if (problems.length === 0) {
			console.log(`ok ${check.name}`);
		} else {
			failed = true;
			console.error(`not ok ${check.name}: ${problems.join("; ")}`);
			if (check.audioStdout === undefined) console.error(`  executable stdout: ${executable.stdout.slice(0, 2000)}`);
			console.error(`  executable stderr: ${executable.stderr.slice(0, 2000)}`);
			if (check.audioStdout === undefined) console.error(`  node stdout: ${node.stdout.slice(0, 2000)}`);
			console.error(`  node stderr: ${node.stderr.slice(0, 2000)}`);
		}
	}
} finally {
	rmSync(directory, { recursive: true });
}

process.exit(failed ? 1 : 0);
