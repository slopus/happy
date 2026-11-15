import {
  commandBaseAt,
  commandBasename,
  HEREDOC_DATA_SINKS,
  isHeredocInterpreter,
  LITERAL_KEY_PREFIX,
  lexicalPath,
  literalCommandToken,
  primaryCommandIndex,
} from "./desktop-guard-words.js";

export function readHeredocDelimiter(
  source: string,
  start: number,
): { end: number; delimiter: string; quoted: boolean } | undefined {
  let index = start;
  while (source[index] === " " || source[index] === "\t") index += 1;
  const first = source[index];
  if (first === undefined || first === "\n" || first === "#") return undefined;
  let delimiter = "";
  let quoted = false;
  let quote: "'" | '"' | undefined;
  while (index < source.length) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else delimiter += character;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quoted = true;
      quote = character;
      index += 1;
      continue;
    }
    if (character === "\\") {
      const next = source[index + 1];
      if (next === undefined || next === "\n") return undefined;
      quoted = true;
      delimiter += next;
      index += 2;
      continue;
    }
    if (character !== undefined && /[\s|&;<>()]/.test(character)) break;
    delimiter += character ?? "";
    index += 1;
  }
  if (quote || delimiter.length === 0) return undefined;
  return { end: index, delimiter, quoted };
}

export function readHeredocBody(
  source: string,
  start: number,
  delimiter: string,
  stripTabs: boolean,
): { end: number; content: string } | undefined {
  let index = start;
  while (index <= source.length) {
    const lineEnd = source.indexOf("\n", index);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const compared = stripTabs
      ? source.slice(index, end).replace(/^\t+/, "")
      : source.slice(index, end);
    if (compared === delimiter) {
      return {
        end: lineEnd === -1 ? source.length : lineEnd + 1,
        content: source.slice(start, index),
      };
    }
    if (lineEnd === -1) return undefined;
    index = lineEnd + 1;
  }
  return undefined;
}

/** Unquoted heredoc bodies expand even inside quote characters. */
export function heredocBodyHazard(body: string): string | undefined {
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "\\") {
      const next = body[index + 1];
      if (next === "$" || next === "`" || next === "\\" || next === "\n") {
        index += 1;
        continue;
      }
    }
    if (character === "`") return "backtick";
    if (character === "$" && body[index + 1] === "(") {
      return body[index + 2] === "(" ? "arithmetic expansion" : "command substitution";
    }
  }
  return undefined;
}

export function quotedHeredocBodyIsDynamic(body: string): boolean {
  if (body.includes("`")) return true;
  for (let index = 0; index < body.length - 1; index += 1) {
    if (body[index] !== "$") continue;
    const next = body[index + 1] ?? "";
    if (next === "(" || next === "{" || /[A-Za-z0-9_*@#?$!-]/.test(next)) return true;
  }
  return false;
}

/** `$name` or `${name}` only. Anything else can hide the word that runs. */
export function skipPlainParameter(body: string, index: number): number | undefined {
  const next = body[index + 1];
  if (next === undefined) return undefined;
  if (next === "{") {
    const match = /^\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(body.slice(index + 1));
    if (!match) return undefined;
    return index + 1 + match[0].length;
  }
  if (/[A-Za-z_]/.test(next)) {
    let cursor = index + 2;
    while (cursor < body.length && /[A-Za-z0-9_]/.test(body[cursor] ?? "")) cursor += 1;
    return cursor;
  }
  if (/[0-9*@#?$!-]/.test(next)) return index + 2;
  return undefined;
}

export function normalizeWrittenPath(path: string): string {
  const collapsed = path.replaceAll(/\/+/g, "/");
  const stripped = collapsed.startsWith("./") ? collapsed.slice(2) : collapsed;
  return stripped.length > 1 && stripped.endsWith("/") ? stripped.slice(0, -1) : stripped;
}

export function isFileWriteRedirect(op: string, target: string): boolean {
  if (op === ">" || op === ">>" || op === "&>") return true;
  return op === ">&" && !/^\d+$/.test(target);
}

export function teeDestinationPaths(words: readonly string[]): string[] {
  const index = primaryCommandIndex(words);
  if (index === undefined) return [];
  if (commandBaseAt(words, index) !== "tee") return [];
  const paths: string[] = [];
  for (const raw of words.slice(index + 1)) {
    const token = literalCommandToken(raw);
    if (!token || token === "--" || (token.startsWith("-") && token !== "-")) continue;
    paths.push(normalizeWrittenPath(token));
  }
  return paths;
}

function pathTail(path: string): string | undefined {
  const base = normalizeWrittenPath(path)
    .split("/")
    .filter((part) => part.length > 0)
    .at(-1);
  if (base === undefined || base === "." || base === "..") return undefined;
  return base;
}

export function resolveExecutionPath(cwd: string | undefined, command: string): string | undefined {
  const joined =
    command.startsWith("/") || cwd === undefined || cwd === ""
      ? command
      : `${cwd.replace(/\/$/, "")}/${command}`;
  const collapsed = lexicalPath(joined);
  if (collapsed === undefined) return undefined;
  return normalizeWrittenPath(collapsed);
}

export function nextHeredocCwd(
  cwd: string | undefined,
  args: readonly string[],
): string | undefined {
  let options = true;
  let target: string | undefined;
  let sawTarget = false;
  for (const raw of args) {
    const token = literalCommandToken(raw);
    if (token === undefined) return undefined;
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (options && token.startsWith("-") && token !== "-") continue;
    target = token;
    sawTarget = true;
    break;
  }
  if (!sawTarget || target === undefined || target === "-" || target.startsWith("~"))
    return undefined;
  if (target.startsWith("/")) return lexicalPath(target) ?? undefined;
  if (cwd === undefined) return undefined;
  return resolveExecutionPath(cwd, target);
}

export function executesWrittenHeredoc(
  words: readonly string[],
  outputs: ReadonlySet<string>,
  bodyDynamic: boolean,
  dir: { cwd: string | undefined },
): boolean {
  if (outputs.size === 0 || words.length === 0) return false;
  const index = primaryCommandIndex(words);
  if (index === undefined) return bodyDynamic;
  const command = literalCommandToken(words[index] ?? "");
  if (!command) return bodyDynamic;
  const base = (command.split("/").at(-1) ?? command).toLowerCase();
  if (base === "cd") return false;
  const matchesWritten = (raw: string) => {
    const token = literalCommandToken(raw);
    if (token === undefined) return false;
    const resolved = resolveExecutionPath(dir.cwd, token);
    if (resolved !== undefined && outputs.has(resolved)) return true;
    // A relative write has no known absolute directory. An absolute path matches
    // only a recorded path, not a shared basename or suffix.
    if (token.startsWith("/")) return false;
    // `cd -` leaves the directory unknown, so a later relative name can still be the file.
    if (dir.cwd !== undefined) return false;
    const name = pathTail(token);
    if (name === undefined) return false;
    for (const output of outputs) {
      if (pathTail(output) === name) return true;
    }
    return false;
  };
  if (base === "chmod") return words.slice(index + 1).some((raw) => matchesWritten(raw));
  return matchesWritten(words[index] ?? "");
}

export function braceExpansionHazard(raw: string): string | undefined {
  if (raw.includes("`")) return "backtick";
  for (let index = 0; index < raw.length - 1; index += 1) {
    if (raw[index] !== "$" || raw[index + 1] !== "(") continue;
    return raw[index + 2] === "(" ? "arithmetic expansion" : "command substitution";
  }
  return undefined;
}

export function readExpansion(
  source: string,
  start: number,
): { end: number; name: string; raw: string; simple: boolean } | undefined {
  if (source[start] !== "$") return undefined;
  const next = source[start + 1];
  if (next === undefined || next === "(") return undefined;
  if (next === "{") {
    let depth = 1;
    let cursor = start + 2;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{" && source[cursor - 1] === "$") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
      if (depth > 0) cursor += 1;
    }
    if (depth !== 0) return undefined;
    const inner = source.slice(start + 2, cursor);
    return {
      end: cursor + 1,
      name: inner,
      raw: source.slice(start, cursor + 1),
      simple: /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner),
    };
  }
  if (/[A-Za-z_]/.test(next)) {
    let cursor = start + 2;
    while (cursor < source.length && /[A-Za-z0-9_]/.test(source[cursor] ?? "")) cursor += 1;
    const name = source.slice(start + 1, cursor);
    return { end: cursor, name, raw: source.slice(start, cursor), simple: true };
  }
  if (/[0-9*@#?$!-]/.test(next)) {
    return { end: start + 2, name: next, raw: source.slice(start, start + 2), simple: false };
  }
  return undefined;
}

export function freshLiteralKey(source: string, used: Set<string>): string {
  let serial = used.size;
  let key = `${LITERAL_KEY_PREFIX}${serial}`;
  while (source.includes(key) || used.has(key)) {
    serial += 1;
    key = `${LITERAL_KEY_PREFIX}${serial}`;
  }
  used.add(key);
  return key;
}

export function isHeredocDataSinkPipeline(names: readonly string[]): boolean {
  return names.length > 0 && names.every((name) => HEREDOC_DATA_SINKS.has(name));
}

/** Shell, source, or a wrapper that can hide them. Used after a heredoc was consumed. */
export function isShellOrSourceCommand(words: readonly string[]): boolean {
  const base = commandBasename(words);
  if (!base) return false;
  return (
    base === "source" ||
    base === "." ||
    base === "sudo" ||
    base === "busybox" ||
    isHeredocInterpreter(base)
  );
}
