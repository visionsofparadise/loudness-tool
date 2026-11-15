import { InvalidArgumentError, type Command } from "commander";
import {
	DEFAULT_OVERSAMPLING,
	OVERSAMPLING_FACTORS,
	type OversamplingFactor,
} from "../../measurement/TruePeakUpsampler";

const isOversamplingFactor = (value: number): value is OversamplingFactor =>
	OVERSAMPLING_FACTORS.some((factor) => factor === value);

const oversamplingMessage = (received: string | number): string =>
	`oversampling must be ${OVERSAMPLING_FACTORS.join(" or ")}, received ${received}`;

export const oversamplingOf = (value: number | undefined): OversamplingFactor => {
	const factor = value ?? DEFAULT_OVERSAMPLING;

	if (!isOversamplingFactor(factor)) {
		throw new Error(oversamplingMessage(factor));
	}

	return factor;
};

const parseOversampling = (value: string): OversamplingFactor => {
	const parsed = Number(value);

	if (!isOversamplingFactor(parsed)) {
		throw new InvalidArgumentError(oversamplingMessage(value));
	}

	return parsed;
};

export const addOversamplingOption = (command: Command): void => {
	command.option(
		"--oversampling <factor>",
		`true-peak oversampling factor, ${OVERSAMPLING_FACTORS.join(" or ")}`,
		parseOversampling,
		DEFAULT_OVERSAMPLING,
	);
};
