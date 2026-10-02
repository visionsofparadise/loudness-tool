const LADDER_MS: ReadonlyArray<number> = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const MILLISECONDS_PER_SECOND = 1000;
const MINIMUM_STEP_FRAMES = 1;

export const MINIMUM_STRETCH_FRAMES = 12;

export interface CrestLayout {
	readonly steps: ReadonlyArray<number>;
	readonly zeroStepIndex: number;
	readonly stretchFrames: number;
	readonly stretchCount: number;
	readonly frameCount: number;
	readonly maxStepFrames: number;
}

export const framesFromMs = (milliseconds: number, sampleRate: number, minimumFrames: number): number =>
	Math.max(minimumFrames, Math.round((milliseconds * sampleRate) / MILLISECONDS_PER_SECOND));

export const stepMagnitudesOf = (spreadMs: number, sampleRate: number): Array<number> => {
	const magnitudes: Array<number> = [];

	for (const milliseconds of [...LADDER_MS.filter((rung) => rung < spreadMs), spreadMs]) {
		const frames = framesFromMs(milliseconds, sampleRate, MINIMUM_STEP_FRAMES);

		if (!magnitudes.includes(frames)) {
			magnitudes.push(frames);
		}
	}

	return magnitudes;
};

export const stretchFramesOf = (args: { spreadMs: number; smoothingMs: number; sampleRate: number }): number =>
	framesFromMs(
		args.smoothingMs / stepMagnitudesOf(args.spreadMs, args.sampleRate).length,
		args.sampleRate,
		MINIMUM_STRETCH_FRAMES,
	);

export const crestLayoutOf = (args: {
	spreadMs: number;
	smoothingMs: number;
	sampleRate: number;
	frameCount: number;
}): CrestLayout => {
	const magnitudes = stepMagnitudesOf(args.spreadMs, args.sampleRate);
	const steps = [...magnitudes].reverse().map((magnitude) => -magnitude);

	steps.push(0, ...magnitudes);

	const stretchFrames = stretchFramesOf(args);

	return {
		steps,
		zeroStepIndex: magnitudes.length,
		stretchFrames,
		stretchCount: Math.ceil(args.frameCount / stretchFrames),
		frameCount: args.frameCount,
		maxStepFrames: magnitudes[magnitudes.length - 1] ?? 0,
	};
};

export const stretchFrameCountOf = (layout: CrestLayout, stretchIndex: number): number =>
	Math.min(layout.stretchFrames, layout.frameCount - stretchIndex * layout.stretchFrames);
