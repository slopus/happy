export type PermissionToolCallLike = {
  kind?: unknown;
  toolName?: unknown;
  rawInput?: unknown;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
};

export type PermissionRequestLike = {
  toolCall?: PermissionToolCallLike | null;
  kind?: unknown;
  rawInput?: unknown;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
};

export function extractPermissionInput(params: PermissionRequestLike): Record<string, unknown> {
  const toolCall = params.toolCall ?? undefined;
  const input =
    (toolCall && (toolCall.rawInput ?? toolCall.input ?? toolCall.arguments ?? toolCall.content))
    ?? params.rawInput
    ?? params.input
    ?? params.arguments
    ?? params.content;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

export function extractPermissionInputWithFallback(
  params: PermissionRequestLike,
  toolCallId: string,
  toolCallIdToInputMap?: Map<string, Record<string, unknown>>
): Record<string, unknown> {
  const extracted = extractPermissionInput(params);
  if (Object.keys(extracted).length > 0) return extracted;

  const fallback = toolCallIdToInputMap?.get(toolCallId);
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback) && Object.keys(fallback).length > 0) {
    return fallback;
  }
  return {};
}

export function extractPermissionToolNameHint(params: PermissionRequestLike): string {
  const toolCall = params.toolCall ?? undefined;
  const kind = typeof toolCall?.kind === 'string' ? toolCall.kind.trim() : '';
  const toolName = typeof toolCall?.toolName === 'string' ? toolCall.toolName.trim() : '';
  const paramsKind = typeof params.kind === 'string' ? params.kind.trim() : '';

  // ACP agents may send `kind: other` for permission prompts while also providing a more specific `toolName`.
  // Prefer the more specific name when kind is generic.
  const genericKind = kind.toLowerCase();
  if (kind && genericKind !== 'other' && genericKind !== 'unknown') return kind;
  if (toolName) return toolName;
  if (paramsKind) return paramsKind;
  return 'Unknown tool';
}

export function resolvePermissionToolName(opts: {
  toolNameHint: string;
  toolCallId: string;
  toolCallIdToNameMap?: Map<string, string>;
}): string {
  const mapped = opts.toolCallIdToNameMap?.get(opts.toolCallId);
  if (typeof mapped === 'string' && mapped.trim().length > 0) {
    return mapped.trim();
  }
  return opts.toolNameHint;
}
