type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function isShellToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'bash' || lower === 'execute' || lower === 'shell' || lower === 'exec' || lower === 'run';
}

function normalizeShellCommandFromArgs(args: UnknownRecord): string | string[] | null {
  const command = args.command;
  if (typeof command === 'string' && command.trim().length > 0) return command.trim();
  const cmdArray = asStringArray(command);
  if (cmdArray && cmdArray.length > 0) return cmdArray;

  const cmd = args.cmd;
  if (typeof cmd === 'string' && cmd.trim().length > 0) return cmd.trim();
  const cmdArray2 = asStringArray(cmd);
  if (cmdArray2 && cmdArray2.length > 0) return cmdArray2;

  const argv = args.argv;
  const argvArray = asStringArray(argv);
  if (argvArray && argvArray.length > 0) return argvArray;

  const items = asStringArray(args.items);
  if (items && items.length > 0) return items;

  return null;
}

function coerceSingleLocationPath(locations: unknown): string | null {
  if (!Array.isArray(locations) || locations.length !== 1) return null;
  const first = locations[0];
  if (!first || typeof first !== 'object') return null;
  const obj = first as Record<string, unknown>;
  const path =
    (typeof obj.path === 'string' && obj.path.trim())
      ? obj.path.trim()
      : (typeof obj.filePath === 'string' && obj.filePath.trim())
        ? obj.filePath.trim()
        : null;
  return path;
}

function coerceFirstItemDiff(items: unknown): Record<string, unknown> | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const first = items[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  return first as Record<string, unknown>;
}

function coerceItemPath(item: Record<string, unknown> | null): string | null {
  if (!item) return null;
  const path =
    (typeof item.path === 'string' && item.path.trim())
      ? item.path.trim()
      : (typeof item.filePath === 'string' && item.filePath.trim())
        ? item.filePath.trim()
        : null;
  return path;
}

function coerceItemText(item: Record<string, unknown> | null, key: 'old' | 'new'): string | null {
  if (!item) return null;
  const candidates =
    key === 'old'
      ? [item.oldText, item.old_string, item.oldString]
      : [item.newText, item.new_string, item.newString];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  return null;
}

function normalizeUrlFromArgs(args: UnknownRecord): string | null {
  const url = args.url;
  if (typeof url === 'string' && url.trim().length > 0) return url.trim();

  const uri = args.uri;
  if (typeof uri === 'string' && uri.trim().length > 0) return uri.trim();

  const link = args.link;
  if (typeof link === 'string' && link.trim().length > 0) return link.trim();

  const href = args.href;
  if (typeof href === 'string' && href.trim().length > 0) return href.trim();

  return null;
}

function normalizeSearchQueryFromArgs(args: UnknownRecord): string | null {
  const query = args.query;
  if (typeof query === 'string' && query.trim().length > 0) return query.trim();

  const q = args.q;
  if (typeof q === 'string' && q.trim().length > 0) return q.trim();

  const pattern = args.pattern;
  if (typeof pattern === 'string' && pattern.trim().length > 0) return pattern.trim();

  const text = args.text;
  if (typeof text === 'string' && text.trim().length > 0) return text.trim();

  return null;
}

/**
 * Normalize ACP tool-call arguments into a shape that our UI renderers and permission matching
 * can consistently understand across providers.
 *
 * NOTE: This must be conservative: only fill well-known aliases; do not delete unknown fields.
 */
export function normalizeAcpToolArgs(opts: {
  toolKind: string | undefined;
  toolName: string;
  rawInput: unknown;
  args: UnknownRecord;
}): UnknownRecord {
  const toolKindLower = (opts.toolKind ?? '').toLowerCase();
  const toolNameLower = opts.toolName.toLowerCase();
  const raw = opts.rawInput;

  const out: UnknownRecord = { ...opts.args };

  // Shell / exec tools: normalize command into `command` (string or string[]).
  if (isShellToolName(toolKindLower) || isShellToolName(toolNameLower)) {
    const fromArgs = normalizeShellCommandFromArgs(out);
    const fromRawArray = asStringArray(raw);
    const normalized = fromArgs ?? (fromRawArray && fromRawArray.length > 0 ? fromRawArray : null);
    if (normalized) {
      out.command = normalized;
    }
  }

  // File ops: normalize common path aliases.
  const filePath =
    (typeof out.file_path === 'string' && out.file_path.length > 0)
      ? out.file_path
      : (typeof out.path === 'string' && out.path.length > 0)
        ? out.path
        : (typeof out.filePath === 'string' && out.filePath.length > 0)
          ? out.filePath
          : null;
  if (filePath && typeof out.file_path !== 'string') {
    out.file_path = filePath;
  }

  // ACP often provides file context via `locations` without rawInput. When we have exactly one
  // location and this looks like a file tool, surface it as `file_path` for our existing views.
  if (typeof out.file_path !== 'string') {
    const locPath = coerceSingleLocationPath(out.locations);
    const isFileTool =
      toolNameLower === 'read' || toolNameLower === 'edit' || toolNameLower === 'write'
      || toolKindLower === 'read' || toolKindLower === 'edit' || toolKindLower === 'write';
    if (isFileTool && locPath) {
      out.file_path = locPath;
    }
  }

  // ACP diff tools often provide file context + content in args.items[0].
  const firstItem = coerceFirstItemDiff(out.items);
  const itemPath = coerceItemPath(firstItem);
  if (itemPath && typeof out.file_path !== 'string') {
    out.file_path = itemPath;
  }

  // Write: normalize `content` from common aliases.
  if (toolNameLower === 'write' || toolKindLower === 'write') {
    if (typeof out.content !== 'string') {
      const content =
        typeof out.text === 'string'
          ? out.text
          : typeof out.data === 'string'
            ? out.data
            : typeof out.newText === 'string'
              ? out.newText
              : null;
      const fromItem = coerceItemText(firstItem, 'new');
      if (typeof content === 'string') out.content = content;
      else if (fromItem) out.content = fromItem;
    }
  }

  // Edit: normalize common field aliases used by ACP agents.
  // (Gemini edit view supports oldText/newText and old_string/new_string, but not oldString/newString.)
  if (toolNameLower === 'edit' || toolKindLower === 'edit') {
    const oldFromItem = coerceItemText(firstItem, 'old');
    const newFromItem = coerceItemText(firstItem, 'new');
    if (typeof out.oldText !== 'string' && typeof out.old_string !== 'string') {
      if (typeof out.oldString === 'string') out.oldText = out.oldString;
      else if (oldFromItem) out.oldText = oldFromItem;
    }
    if (typeof out.newText !== 'string' && typeof out.new_string !== 'string') {
      if (typeof out.newString === 'string') out.newText = out.newString;
      else if (newFromItem) out.newText = newFromItem;
    }
    if (typeof out.path !== 'string' && typeof out.filePath === 'string') {
      out.path = out.filePath;
    }
  }

  // Search: normalize pattern for glob/grep tools.
  if (toolNameLower === 'glob') {
    if (typeof out.pattern !== 'string' && typeof out.glob === 'string') {
      out.pattern = out.glob;
    }
  }
  if (toolNameLower === 'grep') {
    if (typeof out.pattern !== 'string' && typeof out.query === 'string') {
      out.pattern = out.query;
    }
  }

  // Web fetch/search helpers: ensure our existing renderers can find `url` / `query`.
  const isFetchTool =
    toolNameLower === 'webfetch'
    || toolNameLower === 'web_fetch'
    || toolNameLower === 'fetch'
    || toolKindLower === 'webfetch'
    || toolKindLower === 'web_fetch'
    || toolKindLower === 'fetch';
  if (isFetchTool && typeof out.url !== 'string') {
    const normalizedUrl = normalizeUrlFromArgs(out);
    if (normalizedUrl) out.url = normalizedUrl;
  }

  const isWebSearchTool =
    toolNameLower === 'websearch'
    || toolNameLower === 'web_search'
    || toolNameLower === 'search'
    || toolKindLower === 'websearch'
    || toolKindLower === 'web_search'
    || toolKindLower === 'search';
  if (isWebSearchTool && typeof out.query !== 'string') {
    const normalizedQuery = normalizeSearchQueryFromArgs(out);
    if (normalizedQuery) out.query = normalizedQuery;
  }

  return out;
}

/**
 * Normalize ACP tool-result payloads.
 * Keep as-is unless we recognize an obvious wrapper shape.
 */
export function normalizeAcpToolResult(raw: unknown): unknown {
  const obj = asRecord(raw);
  if (!obj) return raw;

  // Some agents wrap results under { output: ... } or { result: ... }.
  if ('output' in obj) return obj.output;
  if ('result' in obj) return obj.result;

  return raw;
}
