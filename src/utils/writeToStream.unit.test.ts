import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeToStream } from "./writeToStream";

const stalledStream = (): Writable =>
	new Writable({
		highWaterMark: 1,
		write: () => undefined,
	});

describe("writeToStream", () => {
	it("writes each buffer in order", async () => {
		const stream = new PassThrough();
		const chunks: Array<Buffer> = [];

		stream.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});

		await writeToStream(stream, Buffer.from([1, 2]));
		await writeToStream(stream, Buffer.from([3]));

		expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
	});

	it("waits for drain when the stream is full", async () => {
		let release: (() => void) | undefined;
		const stream = new Writable({
			highWaterMark: 1,
			write: (_chunk, _encoding, callback) => {
				release = callback;
			},
		});
		let isSettled = false;
		const pending = writeToStream(stream, Buffer.alloc(8)).then(() => {
			isSettled = true;
		});

		await new Promise((resolve) => setImmediate(resolve));

		expect(isSettled).toBe(false);

		release?.();
		await pending;

		expect(isSettled).toBe(true);
	});

	it("rejects with an error emitted between two calls, without an uncaught error event", async () => {
		const stream = new PassThrough();

		stream.resume();

		await writeToStream(stream, Buffer.from([1]));

		expect(() => stream.emit("error", new Error("write EPIPE"))).not.toThrow();

		await expect(writeToStream(stream, Buffer.from([2]))).rejects.toThrow("write EPIPE");
		await expect(writeToStream(stream, Buffer.from([3]))).rejects.toThrow("write EPIPE");
	});

	it("rejects on close during a pending write", async () => {
		const stream = stalledStream();
		const pending = writeToStream(stream, Buffer.alloc(8));

		stream.destroy();

		await expect(pending).rejects.toThrow();
	});

	it("rejects with the error of a stream destroyed during a pending write", async () => {
		const stream = stalledStream();
		const pending = writeToStream(stream, Buffer.alloc(8));

		stream.destroy(new Error("write EPIPE"));

		await expect(pending).rejects.toThrow("write EPIPE");
		await expect(writeToStream(stream, Buffer.alloc(1))).rejects.toThrow("write EPIPE");
	});

	it("rejects when the write callback fails after write returned true", async () => {
		const stream = new Writable({
			highWaterMark: 1024,
			write: (_chunk, _encoding, callback) => {
				setImmediate(() => {
					callback(new Error("write EIO"));
				});
			},
		});
		const pending = writeToStream(stream, Buffer.alloc(8));

		expect(stream.writableLength).toBeLessThan(stream.writableHighWaterMark);

		await expect(pending).rejects.toThrow("write EIO");
		await expect(writeToStream(stream, Buffer.alloc(1))).rejects.toThrow("write EIO");
	});

	it("rejects a write to a stream destroyed before the call", async () => {
		const stream = new PassThrough();

		stream.destroy();
		await new Promise((resolve) => setImmediate(resolve));

		await expect(writeToStream(stream, Buffer.alloc(8))).rejects.toMatchObject({ code: "ERR_STREAM_DESTROYED" });
	});
});
