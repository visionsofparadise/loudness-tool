const MILLISECONDS_PER_SECOND = 1000;
const MINIMUM_STEP_FRAMES = 1;
const MINIMUM_STRETCH_FRAMES = 12;
const SPREAD_RATIO = 4;

export const WEIGHT_LEVELS = 10;

export interface CrestLayout {
	readonly steps: ReadonlyArray<number>;
	readonly stretchFrames: number;
	readonly stretchCount: number;
	readonly frameCount: number;
	readonly maxStepFrames: number;
}

const framesFromMs = (milliseconds: number, sampleRate: number, minimumFrames: number): number =>
	Math.max(minimumFrames, Math.round((milliseconds * sampleRate) / MILLISECONDS_PER_SECOND));

export const stepFramesOf = (args: { spreadMs: number; steps: number; sampleRate: number }): Array<number> => {
	const steps: Array<number> = [];

	for (let index = 0; index < args.steps; index++) {
		const frames = framesFromMs(args.spreadMs / SPREAD_RATIO ** index, args.sampleRate, MINIMUM_STEP_FRAMES);

		if (!steps.includes(frames)) {
			steps.push(frames, -frames);
		}
	}

	return steps;
};

export const stretchFramesOf = (args: { smoothingMs: number; sampleRate: number }): number =>
	framesFromMs(args.smoothingMs / WEIGHT_LEVELS, args.sampleRate, MINIMUM_STRETCH_FRAMES);

export const crestLayoutOf = (args: {
	spreadMs: number;
	steps: number;
	smoothingMs: number;
	sampleRate: number;
	frameCount: number;
}): CrestLayout => {
	const steps = stepFramesOf(args);
	const stretchFrames = stretchFramesOf(args);

	return {
		steps,
		stretchFrames,
		stretchCount: Math.ceil(args.frameCount / stretchFrames),
		frameCount: args.frameCount,
		maxStepFrames: Math.max(0, ...steps),
	};
};

export const stretchFrameCountOf = (layout: CrestLayout, stretchIndex: number): number =>
	Math.min(layout.stretchFrames, layout.frameCount - stretchIndex * layout.stretchFrames);
