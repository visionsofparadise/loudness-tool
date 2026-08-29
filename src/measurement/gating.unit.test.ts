import { describe, expect, it } from "vitest";
import { applyBs1770Gating } from "./gating";

const LUFS_OFFSET = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const BLOCK_SIZE = 19200;

const powerOfLufs = (lufs: number): number => Math.pow(10, (lufs - LUFS_OFFSET) / 10);

const blockSumOfLufs = (lufs: number): number => powerOfLufs(lufs) * BLOCK_SIZE;

describe("applyBs1770Gating", () => {
	it("returns -Infinity when there are no blocks", () => {
		expect(applyBs1770Gating(new Float64Array(0), BLOCK_SIZE)).toBe(-Infinity);
	});

	it("returns -Infinity when every block fails the absolute gate", () => {
		expect(applyBs1770Gating(new Float64Array(8), BLOCK_SIZE)).toBe(-Infinity);
	});

	it("excludes a block whose loudness equals the absolute gate", () => {
		const blockSums = Float64Array.from([blockSumOfLufs(ABSOLUTE_GATE_LUFS)]);

		expect(applyBs1770Gating(blockSums, BLOCK_SIZE)).toBe(-Infinity);
	});

	it("keeps a block just above the absolute gate", () => {
		const lufs = ABSOLUTE_GATE_LUFS + 0.01;
		const blockSums = Float64Array.from([blockSumOfLufs(lufs)]);

		expect(applyBs1770Gating(blockSums, BLOCK_SIZE)).toBeCloseTo(lufs, 10);
	});

	it("excludes a quiet block that fails the relative gate", () => {
		const loudLufs = -20;
		const quietLufs = -50;
		const blockSums = Float64Array.from([
			blockSumOfLufs(loudLufs),
			blockSumOfLufs(loudLufs),
			blockSumOfLufs(loudLufs),
			blockSumOfLufs(quietLufs),
		]);

		expect(applyBs1770Gating(blockSums, BLOCK_SIZE)).toBeCloseTo(loudLufs, 10);
	});

	it("keeps a quieter block that still clears the relative gate", () => {
		const loudLufs = -20;
		const quietLufs = -25;
		const blockSums = Float64Array.from([
			blockSumOfLufs(loudLufs),
			blockSumOfLufs(loudLufs),
			blockSumOfLufs(loudLufs),
			blockSumOfLufs(quietLufs),
		]);
		const expectedMean = (3 * powerOfLufs(loudLufs) + powerOfLufs(quietLufs)) / 4;
		const expectedLufs = LUFS_OFFSET + 10 * Math.log10(expectedMean);

		expect(applyBs1770Gating(blockSums, BLOCK_SIZE)).toBeCloseTo(expectedLufs, 10);
	});

	it("excludes a block whose loudness equals the relative gate", () => {
		const loudPower = powerOfLufs(-20);
		const quietPower = (3 * loudPower) / (10 * 3 + 9);
		const blockSums = Float64Array.from([
			loudPower * BLOCK_SIZE,
			loudPower * BLOCK_SIZE,
			loudPower * BLOCK_SIZE,
			quietPower * BLOCK_SIZE,
		]);

		expect(applyBs1770Gating(blockSums, BLOCK_SIZE)).toBeCloseTo(-20, 10);
	});
});
