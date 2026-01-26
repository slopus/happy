function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function addDiscardedCommittedMessageLocalIds(
  metadata: Record<string, unknown>,
  localIds: string[],
  opts?: { max?: number },
): Record<string, unknown> {
  const max = opts?.max ?? 500;

  const existingRaw = (metadata as any).discardedCommittedMessageLocalIds;
  const existing = isStringArray(existingRaw) ? existingRaw : [];
  const existingSet = new Set(existing);

  const next = [...existing];
  for (const id of localIds) {
    if (typeof id !== 'string' || !id) continue;
    if (existingSet.has(id)) continue;
    existingSet.add(id);
    next.push(id);
  }

  const capped = next.length > max ? next.slice(-max) : next;

  return {
    ...metadata,
    discardedCommittedMessageLocalIds: capped,
  };
}

