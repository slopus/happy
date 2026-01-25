import { isShellCommandAllowed } from './shellCommandAllowlist';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function extractStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

const SHELL_TOOL_NAMES = new Set(['bash', 'execute', 'shell']);

function isShellToolName(name: string): boolean {
  return SHELL_TOOL_NAMES.has(name.toLowerCase());
}

function parseParenIdentifier(value: string): { name: string; spec: string } | null {
  const match = value.match(/^([^(]+)\((.*)\)$/);
  if (!match) return null;
  return { name: match[1], spec: match[2] };
}

export function extractShellCommand(input: unknown): string | null {
  const obj = asRecord(input);
  if (!obj) return null;

  const command = obj.command;
  if (typeof command === 'string' && command.trim().length > 0) return command.trim();

  const cmdArray = extractStringArray(command);
  if (cmdArray && cmdArray.length > 0) {
    if (
      cmdArray.length >= 3
      && (cmdArray[0] === 'bash' || cmdArray[0] === '/bin/bash' || cmdArray[0] === 'zsh' || cmdArray[0] === '/bin/zsh')
      && cmdArray[1] === '-lc'
      && typeof cmdArray[2] === 'string'
    ) {
      return cmdArray[2];
    }
    return cmdArray.join(' ');
  }

  const cmd = obj.cmd;
  if (typeof cmd === 'string' && cmd.trim().length > 0) return cmd.trim();
  const cmdArray2 = extractStringArray(cmd);
  if (cmdArray2 && cmdArray2.length > 0) return extractShellCommand({ command: cmdArray2 });

  const argvArray = extractStringArray(obj.argv);
  if (argvArray && argvArray.length > 0) return extractShellCommand({ command: argvArray });

  const itemsArray = extractStringArray(obj.items);
  if (itemsArray && itemsArray.length > 0) return extractShellCommand({ command: itemsArray });

  const toolCall = asRecord(obj.toolCall);
  const rawInput = toolCall ? asRecord(toolCall.rawInput) : null;
  if (rawInput) return extractShellCommand(rawInput);

  return null;
}

export function makeToolIdentifier(toolName: string, input: unknown): string {
  const command = extractShellCommand(input);
  if (command && isShellToolName(toolName)) {
    return `${toolName}(${command})`;
  }
  return toolName;
}

export function isToolAllowedForSession(
  allowedIdentifiers: Iterable<string>,
  toolName: string,
  input: unknown
): boolean {
  const command = extractShellCommand(input);
  const isShell = isShellToolName(toolName);

  // Fast path: exact match on canonical identifier.
  const exact = makeToolIdentifier(toolName, input);
  for (const item of allowedIdentifiers) {
    if (item === exact) return true;
  }

  // Shell tools: accept per-command identifiers across shell-tool synonyms and prefix patterns.
  if (isShell && command) {
    const patterns: Array<{ kind: 'exact'; value: string } | { kind: 'prefix'; value: string }> = [];
    for (const item of allowedIdentifiers) {
      if (typeof item !== 'string') continue;
      const parsed = parseParenIdentifier(item);
      if (!parsed) continue;
      if (!isShellToolName(parsed.name)) continue;

      const spec = parsed.spec;
      if (spec.endsWith(':*')) {
        const prefix = spec.slice(0, -2).trim();
        if (prefix) patterns.push({ kind: 'prefix', value: prefix });
      } else if (spec.trim().length > 0) {
        patterns.push({ kind: 'exact', value: spec.trim() });
      }
    }

    if (patterns.length > 0 && isShellCommandAllowed(command, patterns)) return true;
  }

  // Non-shell tools: allow direct tool-name identifiers (legacy).
  if (!isShell) {
    for (const item of allowedIdentifiers) {
      if (item === toolName) return true;
    }
  }

  return false;
}
