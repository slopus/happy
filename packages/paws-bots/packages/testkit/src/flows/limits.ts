/**
 * Guards the numeric flow limits before any paid resource starts: a value the CLI cannot
 * parse (a decimal comma, a unit suffix) becomes NaN, every limit comparison is then always
 * false, and the run continues without a deadline, turn or spend cap.
 */
export function validateFlowLimits(input: {
  deadlineMin: number;
  maxUserTurns: number;
  spendCapUsd: number;
}) {
  for (const [name, value] of [
    ["--deadline-min", input.deadlineMin],
    ["--spend-cap-usd", input.spendCapUsd],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  }
  if (!Number.isSafeInteger(input.maxUserTurns) || input.maxUserTurns < 1)
    throw new Error("--max-turns must be an integer of at least 1");
}
