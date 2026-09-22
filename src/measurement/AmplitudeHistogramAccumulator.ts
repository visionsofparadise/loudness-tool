const histogramMedianOf = (buckets: Float64Array, totalMass: number, bucketMax: number): number => {
	const bucketCount = buckets.length;
	const target = totalMass / 2;
	const bucketWidth = bucketMax / bucketCount;
	let cumulative = 0;
	let median = 0;

	for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
		const mass = buckets[bucketIndex] ?? 0;
		const next = cumulative + mass;

		if (next >= target) {
			const fraction = mass > 0 ? (target - cumulative) / mass : 0;

			median = (bucketIndex + fraction) * bucketWidth;

			break;
		}

		cumulative = next;
	}

	return median;
};

export class AmplitudeHistogramAccumulator {
	private readonly bucketCount: number;
	private buckets: Float64Array;
	private currentBucketMax = 0;
	private totalSamples = 0;
	private totalMass = 0;
	private pendingZeroMass = 0;
	private finalized = false;
	private cachedResult: { buckets: Float64Array; bucketMax: number; median: number } | undefined;

	constructor(bucketCount: number) {
		if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
			throw new Error(
				`AmplitudeHistogramAccumulator: bucketCount must be a positive integer, got ${String(bucketCount)}`,
			);
		}

		this.bucketCount = bucketCount;
		this.buckets = new Float64Array(bucketCount);
	}

	push(samples: Float64Array, count: number, weights?: Float64Array): void {
		if (this.finalized) {
			throw new Error("AmplitudeHistogramAccumulator: push() called after finalize()");
		}

		if (count <= 0) {
			return;
		}

		if (samples.length < count) {
			throw new Error(
				`AmplitudeHistogramAccumulator: samples has ${samples.length} values, fewer than the requested ${count}`,
			);
		}

		if (weights !== undefined && weights.length < count) {
			throw new Error(
				`AmplitudeHistogramAccumulator: weights has ${weights.length} values, fewer than the requested ${count}`,
			);
		}

		let chunkMax = 0;
		let chunkMass = 0;

		for (let index = 0; index < count; index++) {
			const value = Math.abs(samples[index] ?? 0);

			if (value > chunkMax) {
				chunkMax = value;
			}

			chunkMass += weights === undefined ? 1 : (weights[index] ?? 0);
		}

		this.totalSamples += count;
		this.totalMass += chunkMass;

		if (chunkMax > this.currentBucketMax) {
			this.rebucket(chunkMax);
		}

		if (this.currentBucketMax === 0) {
			this.pendingZeroMass += chunkMass;

			return;
		}

		const scale = this.bucketCount / this.currentBucketMax;
		const lastBucket = this.bucketCount - 1;

		for (let index = 0; index < count; index++) {
			const value = Math.abs(samples[index] ?? 0);
			let bucketIndex = Math.floor(value * scale);

			if (bucketIndex < 0) {
				bucketIndex = 0;
			} else if (bucketIndex > lastBucket) {
				bucketIndex = lastBucket;
			}

			this.buckets[bucketIndex] =
				(this.buckets[bucketIndex] ?? 0) + (weights === undefined ? 1 : (weights[index] ?? 0));
		}
	}

	finalize(): { buckets: Float64Array; bucketMax: number; median: number } {
		if (this.cachedResult !== undefined) {
			return this.cachedResult;
		}

		this.finalized = true;

		if (this.totalSamples === 0 || this.currentBucketMax === 0) {
			this.cachedResult = { buckets: this.buckets, bucketMax: 0, median: 0 };

			return this.cachedResult;
		}

		const median = histogramMedianOf(this.buckets, this.totalMass, this.currentBucketMax);

		this.cachedResult = { buckets: this.buckets, bucketMax: this.currentBucketMax, median };

		return this.cachedResult;
	}

	private rebucket(newMax: number): void {
		if (this.currentBucketMax === 0) {
			if (this.pendingZeroMass > 0) {
				this.buckets[0] = (this.buckets[0] ?? 0) + this.pendingZeroMass;
				this.pendingZeroMass = 0;
			}

			this.currentBucketMax = newMax;

			return;
		}

		const oldBuckets = this.buckets;
		const oldMax = this.currentBucketMax;
		const newBuckets = new Float64Array(this.bucketCount);
		const lastBucket = this.bucketCount - 1;
		const oldWidth = oldMax / this.bucketCount;
		const newScale = this.bucketCount / newMax;

		for (let oldIndex = 0; oldIndex < this.bucketCount; oldIndex++) {
			const mass = oldBuckets[oldIndex] ?? 0;

			if (mass === 0) {
				continue;
			}

			const center = (oldIndex + 0.5) * oldWidth;
			let newIndex = Math.floor(center * newScale);

			if (newIndex < 0) {
				newIndex = 0;
			} else if (newIndex > lastBucket) {
				newIndex = lastBucket;
			}

			newBuckets[newIndex] = (newBuckets[newIndex] ?? 0) + mass;
		}

		this.buckets = newBuckets;
		this.currentBucketMax = newMax;
	}
}
