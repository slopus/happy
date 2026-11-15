/** A full replacement diff keeps every removed constraint visible during approval. */
export function instructionUpdateDiff(before: string, after: string): string {
  if (!before.trim()) return after;
  const lines = (text: string, sign: string) =>
    text
      .split("\n")
      .map((line) => `${sign} ${line}`)
      .join("\n");
  return `${lines(before, "-")}\n${lines(after, "+")}`;
}
