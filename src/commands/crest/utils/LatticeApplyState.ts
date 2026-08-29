import { applyLatticeSample } from "./lattice";
import type { ControlTrajectory } from "./trajectory";

export class LatticeApplyState {
	private readonly rows: ReadonlyArray<Float64Array>;
	private readonly frameCount: number;
	private readonly state: ReadonlyArray<Float64Array>;
	private readonly interpolated: Float64Array;
	private sample = 0;

	constructor(
		private readonly trajectory: ControlTrajectory,
		private readonly order: number,
		private readonly hopSize: number,
		channelCount: number,
	) {
		this.rows = trajectory.rows;
		this.frameCount = this.rows.length;
		this.state = Array.from({ length: channelCount }, () => new Float64Array(order));
		this.interpolated = new Float64Array(order);
	}

	apply(channels: ReadonlyArray<Float64Array>, frames: number): void {
		const channelCount = this.state.length;
		const order = this.order;
		const hopSize = this.hopSize;
		const interpolated = this.interpolated;
		const identity = this.trajectory.identity;

		for (let index = 0; index < frames; index++) {
			const framePos = hopSize > 0 ? this.sample / hopSize : 0;
			const frame0 = Math.min(this.frameCount - 1, Math.max(0, Math.floor(framePos)));
			const frame1 = Math.min(this.frameCount - 1, frame0 + 1);
			const fraction = framePos - frame0;
			const row0 = this.rows[frame0] ?? identity;
			const row1 = this.rows[frame1] ?? identity;

			for (let section = 0; section < order; section++) {
				interpolated[section] = (row0[section] ?? 0) + fraction * ((row1[section] ?? 0) - (row0[section] ?? 0));
			}

			for (let channel = 0; channel < channelCount; channel++) {
				const channelSamples = channels[channel];
				const channelState = this.state[channel];

				if (channelSamples === undefined || channelState === undefined) {
					continue;
				}

				channelSamples[index] = applyLatticeSample(
					channelSamples[index] ?? 0,
					channelState,
					interpolated,
					1,
					order,
				);
			}

			this.sample += 1;
		}
	}
}
