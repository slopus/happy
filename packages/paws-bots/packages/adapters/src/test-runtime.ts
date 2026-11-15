/** Vitest sets VITEST=true; false-like deployment values must not disable live adapters. */
export function isVitestRuntime(value: string | undefined = process.env.VITEST): boolean {
  return value === "true" || value === "1";
}
