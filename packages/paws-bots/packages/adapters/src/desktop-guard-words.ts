export const SHELL_INTERPRETER_NAMES = /^(?:bash|sh|dash|zsh|ksh|fish)$/;

export const STATIC_SHELL_EXPANSIONS: Readonly<Record<string, string>> = {
  HOME: "/home/rakazo",
  LOGNAME: "rakazo",
  PATH: "/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  PWD: "/home/rakazo",
  TMPDIR: "/tmp",
  USER: "rakazo",
  WORKSPACE: "/home/rakazo/workspace",
  XDG_CONFIG_HOME: "/home/rakazo/.config",
};

export const SAFE_SHELL_CONTROL_OPS = new Set([
  "&&",
  "||",
  ";",
  "|",
  "&",
  ">",
  "<",
  ">>",
  ">&",
  "<&",
  "&>",
]);

/** Commands whose stdin heredoc is code, not data. Versioned names are matched separately. */
const HEREDOC_INTERPRETERS = new Set([
  "ash",
  "bash",
  "bun",
  "csh",
  "dash",
  "deno",
  "elixir",
  "fish",
  "julia",
  "ksh",
  "lua",
  "node",
  "nodejs",
  "perl",
  "php",
  "powershell",
  "pwsh",
  "pypy",
  "pypy3",
  "python",
  "python2",
  "python3",
  "ruby",
  "sh",
  "tcsh",
  "zsh",
]);

/** Stdin sinks. Any other heredoc consumer can run the body. */
export const HEREDOC_DATA_SINKS = new Set(["cat", "tee"]);

const COMMAND_WRAPPERS = new Set([
  "builtin",
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "stdbuf",
  "time",
]);

export const LITERAL_KEY_PREFIX = "RKZLIT";

type AssignmentEntry = { name: string; value: string | null };

export function isHeredocInterpreter(name: string): boolean {
  if (HEREDOC_INTERPRETERS.has(name)) return true;
  return /^(?:python|ruby|perl|php|node)[\d.]+$/.test(name);
}

export function isLiteralActivatePath(text: string): boolean {
  return /(?:^|\/)bin\/activate$/.test(text);
}

/**
 * Collapse repeated slashes and `.` / `..` without reading the filesystem.
 * A relative `..` that escapes the visible prefix stays in the result.
 * Undefined only when the path contains a null byte.
 */
export function lexicalPath(path: string): string | undefined {
  if (path.includes("\0")) return undefined;
  const absolute = path.startsWith("/");
  const stack: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (absolute && stack.length === 0) continue;
      if (stack.length === 0 || stack.at(-1) === "..") stack.push("..");
      else stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (absolute) return `/${stack.join("/")}`;
  return stack.join("/");
}

/** A write can plant `bin/activate`, or the path contains a null byte. */
function isActivateWritePath(path: string): boolean {
  const normalized = lexicalPath(path);
  if (normalized === undefined) return true;
  return isLiteralActivatePath(normalized);
}

/** Refuse planting a script that `source …/bin/activate` would later run unchecked. */
export function protectedActivateScriptWriteRefusal(path: string): string | undefined {
  return isActivateWritePath(path) ? "activate script" : undefined;
}

export function unresolvedVariableReason(name: string): string {
  const trimmed = name.replaceAll(/[\r\n]/g, "").slice(0, 48);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return `unresolved variable $${trimmed}`;
  return `unresolved variable \${${trimmed}}`;
}

/** Quote-removed literal, or undefined when the word expands, globs, or runs a command. */
export function literalCommandToken(raw: string): string | undefined {
  let text = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else text += character;
      continue;
    }
    if (character === "\\") {
      const next = raw[index + 1];
      if (next === undefined || next === "$" || next === "`") return undefined;
      text += next;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "$" || character === "`") return undefined;
      else text += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "$" || character === "`" || character === "*" || character === "?") {
      return undefined;
    }
    text += character;
  }
  if (quote) return undefined;
  return text;
}

function literalAssignmentValue(raw: string): string | undefined {
  let value = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else value += character;
      continue;
    }
    if (character === "\\") {
      const next = raw[index + 1];
      if (next === undefined) return undefined;
      const quotedLiteralEscape =
        quote === '"' &&
        next !== '"' &&
        next !== "\\" &&
        next !== "$" &&
        next !== "`" &&
        next !== "\n";
      value += quotedLiteralEscape ? `\\${next}` : next;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "$" || character === "`") return undefined;
      else value += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "$" || character === "`") return undefined;
    value += character;
  }
  if (quote) return undefined;
  return value;
}

function parseAssignment(raw: string): AssignmentEntry | undefined {
  if (raw.startsWith("'") || raw.startsWith('"')) return undefined;
  const append = /^([A-Za-z_][A-Za-z0-9_]*)\+=/.exec(raw);
  if (append?.[1]) return { name: append[1], value: null };
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(raw);
  if (!match?.[1]) return undefined;
  const value = literalAssignmentValue(raw.slice(match[0].length));
  return { name: match[1], value: value ?? null };
}

export function assignmentEntries(words: readonly string[]): AssignmentEntry[] | undefined {
  if (words.length === 0) return undefined;
  let index = 0;
  if (literalCommandToken(words[0] ?? "") === "export") index = 1;
  if (index >= words.length) return undefined;
  const entries: AssignmentEntry[] = [];
  for (; index < words.length; index += 1) {
    const parsed = parseAssignment(words[index] ?? "");
    if (!parsed) return undefined;
    entries.push(parsed);
  }
  return entries;
}

function isRawAssignment(raw: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\+?=)/.test(raw);
}

export function primaryCommandIndex(words: readonly string[]): number | undefined {
  let index = 0;
  while (index < words.length) {
    const raw = words[index] ?? "";
    if (isRawAssignment(raw)) {
      index += 1;
      continue;
    }
    const text = literalCommandToken(raw);
    if (text === undefined) return undefined;
    if (text === "!") {
      index += 1;
      continue;
    }
    const base = text.split("/").at(-1) ?? text;
    if (COMMAND_WRAPPERS.has(base)) {
      index += 1;
      while (
        index < words.length &&
        (literalCommandToken(words[index] ?? "") ?? "").startsWith("-")
      ) {
        index += 1;
      }
      continue;
    }
    return index;
  }
  return undefined;
}

export function commandBasename(words: readonly string[]): string | undefined {
  if (words.length === 0 || assignmentEntries(words)) return undefined;
  const commandIndex = primaryCommandIndex(words);
  if (commandIndex === undefined) return "";
  const text = literalCommandToken(words[commandIndex] ?? "");
  if (!text) return "";
  return (text.split("/").at(-1) ?? "").toLowerCase();
}

export function isUnsafeSource(words: readonly string[]): boolean {
  const commandIndex = primaryCommandIndex(words);
  if (commandIndex === undefined) return false;
  const primary = literalCommandToken(words[commandIndex] ?? "");
  // Only the exact builtins. A variable path can hide an arbitrary script.
  if (primary !== "source" && primary !== ".") return false;
  const argument = words[commandIndex + 1];
  if (argument === undefined) return true;
  const text = literalCommandToken(argument);
  if (text === undefined) return true;
  return !isLiteralActivatePath(text);
}

const EXTERNAL_ASSIGNMENT_COMMANDS = new Set([
  "declare",
  "getopts",
  "local",
  "mapfile",
  "read",
  "readarray",
  "readonly",
  "typeset",
]);

const ACTIVATE_DESTINATION_COMMANDS = new Set(["cp", "install", "ln", "mv"]);

export function commandBaseAt(words: readonly string[], index: number): string | undefined {
  const text = literalCommandToken(words[index] ?? "");
  if (!text) return undefined;
  return (text.split("/").at(-1) ?? text).toLowerCase();
}

function identifierFromToken(token: string | undefined): string | undefined {
  if (token && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return token;
  return undefined;
}

/** A redirect or writer operand, resolved when it is one tracked literal. */
function activateOperand(
  raw: string,
  words: readonly string[],
  env: ReadonlyMap<string, string>,
): string | undefined {
  const literal = literalCommandToken(raw);
  if (literal !== undefined) return literal;
  const bare = raw.replaceAll(/['"]/g, "");
  if (isLiteralActivatePath(bare)) return bare;
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(bare);
  const name = match?.[1] ?? match?.[2];
  if (!name) return undefined;
  for (const word of words) {
    const parsed = parseAssignment(word);
    if (!parsed) break;
    if (parsed.name === name && parsed.value !== null) return parsed.value;
  }
  return env.get(name);
}

export function isActivateWriteTarget(
  op: string,
  raw: string,
  words: readonly string[],
  env: ReadonlyMap<string, string>,
): boolean {
  if (op !== ">" && op !== ">>" && op !== "&>" && op !== ">&") return false;
  const text = activateOperand(raw, words, env);
  if (text === undefined) return false;
  if (op === ">&" && /^\d+$/.test(text)) return false;
  return isActivateWritePath(text);
}

export function commandWritesActivateScript(
  words: readonly string[],
  env: ReadonlyMap<string, string>,
): boolean {
  const index = primaryCommandIndex(words);
  if (index === undefined) return false;
  const base = commandBaseAt(words, index);
  if (!base) return false;
  const args = words.slice(index + 1);
  if (base === "dd") {
    return args.some((raw) => {
      const token = literalCommandToken(raw);
      return Boolean(token?.startsWith("of=") && isActivateWritePath(token.slice("of=".length)));
    });
  }
  if (base === "tee") {
    return args.some((raw) => {
      const token = literalCommandToken(raw);
      if (token === "--" || (token?.startsWith("-") && token !== "-")) return false;
      const value = activateOperand(raw, words, env);
      return value !== undefined && isActivateWritePath(value);
    });
  }
  if (!ACTIVATE_DESTINATION_COMMANDS.has(base)) return false;
  return copyCommandWritesActivate(base, args, words, env);
}

const COPY_ARGUMENT_LETTERS: Record<string, string> = {
  cp: "tS",
  install: "gmotS",
  ln: "tS",
  mv: "tS",
};

const COPY_LONG_ARGUMENTS = new Set([
  "--group",
  "--mode",
  "--owner",
  "--strip-program",
  "--suffix",
  "--target-directory",
]);

/** `cp -t dir file` writes `dir/file`, not `file`. The same `-t` form applies to install, ln, and mv. */
function copyCommandWritesActivate(
  base: string,
  args: readonly string[],
  words: readonly string[],
  env: ReadonlyMap<string, string>,
): boolean {
  const letters = COPY_ARGUMENT_LETTERS[base] ?? "t";
  let targetDir: string | undefined;
  const sources: string[] = [];
  let hiddenSource = false;
  let recursive = false;
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? "";
    const token = literalCommandToken(raw);
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (options && token?.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      let value = eq === -1 ? undefined : token.slice(eq + 1);
      if (COPY_LONG_ARGUMENTS.has(name) && eq === -1) {
        index += 1;
        value = index < args.length ? activateOperand(args[index] ?? "", words, env) : undefined;
      }
      if (name === "--recursive" || name === "--archive") recursive = true;
      if (name === "--target-directory") {
        if (value === undefined) return true;
        targetDir = value;
      }
      continue;
    }
    if (options && token?.startsWith("-") && token !== "-") {
      for (let cursor = 1; cursor < token.length; cursor += 1) {
        const letter = token[cursor] ?? "";
        if (base === "cp" && (letter === "a" || letter === "r" || letter === "R")) recursive = true;
        if (!letters.includes(letter)) continue;
        const rest = token.slice(cursor + 1);
        let value: string | undefined;
        if (rest.length > 0) value = rest;
        else if (index + 1 < args.length) {
          index += 1;
          value = activateOperand(args[index] ?? "", words, env);
        }
        if (letter === "t") {
          if (value === undefined) return true;
          targetDir = value;
        }
        break;
      }
      continue;
    }
    const value = token === undefined ? activateOperand(raw, words, env) : token;
    if (value === undefined) {
      hiddenSource = true;
      continue;
    }
    sources.push(value);
  }
  if (targetDir !== undefined) {
    if (hiddenSource) return true;
    const directory = targetDir;
    if (transfersBinDirectory(base, recursive, true, directory, sources)) return true;
    return sources.some((source) => copiedIntoActivates(directory, source));
  }
  const destination = sources.at(-1);
  if (
    destination !== undefined &&
    transfersBinDirectory(
      base,
      recursive,
      isDirectoryDestination(destination),
      destination,
      sources.slice(0, -1),
    )
  ) {
    return true;
  }
  return destination !== undefined && isActivateWritePath(destination);
}

function lastPathComponent(path: string): string {
  const stripped = path.replace(/\/+$/, "");
  const collapsed = lexicalPath(stripped) ?? stripped;
  const slash = collapsed.lastIndexOf("/");
  return slash === -1 ? collapsed : collapsed.slice(slash + 1);
}

function isDirectoryDestination(path: string): boolean {
  return path.endsWith("/") || lastPathComponent(path) === "." || lastPathComponent(path) === "..";
}

/**
 * Placing a directory named bin onto another bin, or into a directory, can
 * plant bin/activate. A destination that merely ends in bin is a file rename.
 */
function transfersBinDirectory(
  base: string,
  recursive: boolean,
  destIsDirectory: boolean,
  destination: string,
  sources: readonly string[],
): boolean {
  if (base !== "mv" && base !== "ln" && !(base === "cp" && recursive)) return false;
  if (!sources.some((source) => lastPathComponent(source) === "bin")) return false;
  if (lastPathComponent(destination) === "bin") return true;
  return destIsDirectory;
}

function copiedIntoActivates(directory: string, source: string): boolean {
  const stripped = source.replace(/\/+$/, "");
  const slash = stripped.lastIndexOf("/");
  const name = slash === -1 ? stripped : stripped.slice(slash + 1);
  if (name === "" || name === "." || name === "..") return isActivateWritePath(directory);
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return isActivateWritePath(`${prefix}${name}`);
}

function printfAssignedName(args: readonly string[]): string | null | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = literalCommandToken(args[index] ?? "");
    if (token === undefined) return null;
    if (token === "--") return undefined;
    if (token === "-v") {
      return identifierFromToken(literalCommandToken(args[index + 1] ?? "")) ?? null;
    }
    if (token.startsWith("-v")) return identifierFromToken(token.slice(2)) ?? null;
    if (token.startsWith("-")) continue;
    return undefined;
  }
  return undefined;
}

/**
 * Variables a command may assign outside a plain assignment list.
 * `clear` drops every tracked literal: the target was not a fixed name, a
 * nameref can retarget one, or a sourced script can assign anything.
 * Undefined means this command cannot.
 */
export function externalAssignments(
  words: readonly string[],
): { clear: boolean; names: readonly string[] } | undefined {
  const index = primaryCommandIndex(words);
  if (index === undefined) return undefined;
  const base = commandBaseAt(words, index);
  if (!base) return { clear: true, names: [] };
  const args = words.slice(index + 1);
  if (base === "source" || base === ".") return { clear: true, names: [] };
  if (base === "for") {
    const name = identifierFromToken(literalCommandToken(args[0] ?? ""));
    if (!name) return { clear: true, names: [] };
    return { clear: false, names: [name] };
  }
  if (base === "printf") {
    const target = printfAssignedName(args);
    if (target === undefined) return undefined;
    if (target === null) return { clear: true, names: [] };
    return { clear: false, names: [target] };
  }
  if (!EXTERNAL_ASSIGNMENT_COMMANDS.has(base)) return undefined;
  const names: string[] = [];
  if (base === "read") names.push("REPLY");
  if (base === "mapfile" || base === "readarray") names.push("MAPFILE");
  if (base === "getopts") names.push("OPTARG", "OPTIND");
  const namerefCommand =
    base === "declare" || base === "local" || base === "readonly" || base === "typeset";
  let options = true;
  let nameref = false;
  for (const raw of args) {
    const token = literalCommandToken(raw);
    if (token === undefined) return { clear: true, names };
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (options && token.startsWith("-")) {
      // `-n` retargets a later assignment. Drop every literal instead of following it.
      if (namerefCommand && !token.startsWith("--") && token.slice(1).includes("n")) nameref = true;
      continue;
    }
    const parsed = parseAssignment(raw);
    if (parsed) {
      names.push(parsed.name);
      continue;
    }
    const name = identifierFromToken(token);
    if (name) names.push(name);
  }
  if (nameref) return { clear: true, names: [] };
  return { clear: false, names };
}
