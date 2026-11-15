const codes = new WeakMap<object, string>();

/**
 * A refusal the model reads, tagged with a fixed code for the logs. The sentence can name bots,
 * arguments or sites the run was given, so only the code is ever logged.
 */
export function refusal(code: string, error: string): { error: string } {
  const refused = { error };
  codes.set(refused, code);
  return refused;
}

/** The code a refusal was tagged with, or undefined for any other result. */
export function refusalCode(result: unknown): string | undefined {
  return result && typeof result === "object" ? codes.get(result) : undefined;
}

/** A logged refusal: its code, and the connector tool a catalog call resolved to, if any. */
export type ToolRefusal = { code: string; target?: string };
