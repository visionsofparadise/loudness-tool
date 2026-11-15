import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { noticesOf } from "./package.mjs";

describe("scripts/package.mjs", () => {
	it("carries the licence of each production dependency and the Bun runtime", () => {
		const notices = noticesOf(resolve("."));

		expect(notices).toMatch(/^commander \d+\.\d+\.\d+ \(MIT\)$/mu);
		expect(notices).toContain("Copyright (c) 2011 TJ Holowaychuk");
		expect(notices).toMatch(/^Bun \d+\.\d+\.\d+, compiled into the executable$/mu);
		expect(notices).toContain("Bun statically links JavaScriptCore");
		expect(notices).not.toMatch(/^(vitest|bun|typescript) /mu);
	});
});
