export const isMultipleOf = (value: number, step: number): boolean => {
	const valueDecimals = (value.toString().split(".")[1] ?? "").length;
	const stepDecimals = (step.toString().split(".")[1] ?? "").length;
	const decimals = valueDecimals > stepDecimals ? valueDecimals : stepDecimals;
	const scaledValue = Number.parseInt(value.toFixed(decimals).replace(".", ""), 10);
	const scaledStep = Number.parseInt(step.toFixed(decimals).replace(".", ""), 10);

	return scaledValue % scaledStep === 0;
};
