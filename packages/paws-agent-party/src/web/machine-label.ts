/** SDK metadata is decrypted but remains untyped at this boundary. */
export function machineLabel(machine: { id: string; active: boolean; metadata?: unknown }): string {
  const metadata = machine.metadata && typeof machine.metadata === 'object'
    ? machine.metadata as Record<string, unknown> : {};
  const name = nonEmpty(metadata.displayName);
  const host = nonEmpty(metadata.host);
  const identity = name && host && name !== host ? `${name}（${host}）`
    : name ?? host ?? `未命名设备 · ${machine.id.slice(0, 8)}${machine.id.length > 8 ? '…' : ''}`;
  return `${identity} · ${machine.active ? '在线' : '离线'}`;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
