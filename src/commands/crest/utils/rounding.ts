import { linearToDb } from "../../../utils/db";

export const printedDbOf = (amplitude: number): number => Number(linearToDb(amplitude).toFixed(2));
