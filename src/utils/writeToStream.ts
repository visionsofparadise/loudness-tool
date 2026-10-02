interface StreamState {
	error: Error | undefined;
}

const streamStates = new WeakMap<NodeJS.WritableStream, StreamState>();

const streamStateOf = (stream: NodeJS.WritableStream): StreamState => {
	const existing = streamStates.get(stream);

	if (existing !== undefined) {
		return existing;
	}

	const state: StreamState = { error: undefined };

	stream.on("error", (error: Error) => {
		state.error ??= error;
	});
	streamStates.set(stream, state);

	return state;
};

export const writeToStream = async (stream: NodeJS.WritableStream, buffer: Buffer): Promise<void> => {
	const state = streamStateOf(stream);

	if (state.error !== undefined) {
		throw state.error;
	}

	await new Promise<void>((resolve, reject) => {
		let isWritten = false;
		let isDrained = false;
		const settle = (error?: Error): void => {
			stream.removeListener("error", onError);
			stream.removeListener("close", onClose);
			stream.removeListener("drain", onDrain);

			if (error === undefined) {
				resolve();
			} else {
				reject(error);
			}
		};
		const settleWhenDone = (): void => {
			if (isWritten && isDrained) {
				settle();
			}
		};
		const onError = (error: Error): void => {
			settle(error);
		};
		const onClose = (): void => {
			settle(state.error ?? new Error("Output stream closed before the write completed"));
		};
		const onDrain = (): void => {
			isDrained = true;
			settleWhenDone();
		};

		stream.on("error", onError);
		stream.on("close", onClose);
		stream.on("drain", onDrain);

		isDrained = stream.write(buffer, (error) => {
			if (error !== undefined && error !== null) {
				state.error ??= error;
				settle(error);

				return;
			}

			isWritten = true;
			settleWhenDone();
		});
	});
};
