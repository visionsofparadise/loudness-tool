export class MeasurementOverflow extends Error {
	readonly frame: number;

	constructor(frame: number) {
		super(`the measurement overflows at frame ${frame}`);
		this.name = "MeasurementOverflow";
		this.frame = frame;
	}
}
