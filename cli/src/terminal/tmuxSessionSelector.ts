export type TmuxSessionListRow = {
  name: string;
  attached: number;
  lastAttached: number;
};

function parseIntOrZero(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseTmuxSessionList(stdout: string): TmuxSessionListRow[] {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return [];

  return stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length < 3) return null;
      const [nameRaw, attachedRaw, lastAttachedRaw] = parts;
      const name = (nameRaw ?? '').trim();
      if (name.length === 0) return null;
      return {
        name,
        attached: parseIntOrZero(attachedRaw),
        lastAttached: parseIntOrZero(lastAttachedRaw),
      } satisfies TmuxSessionListRow;
    })
    .filter((row): row is TmuxSessionListRow => row !== null);
}

export function selectPreferredTmuxSessionName(stdout: string): string | null {
  const rows = parseTmuxSessionList(stdout);
  if (rows.length === 0) return null;

  rows.sort((a, b) => {
    if (a.attached !== b.attached) return b.attached - a.attached;
    return b.lastAttached - a.lastAttached;
  });

  return rows[0]?.name ?? null;
}
