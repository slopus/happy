import { parse as parseShellCommand } from "shell-quote";
import {
  braceExpansionHazard,
  executesWrittenHeredoc,
  freshLiteralKey,
  heredocBodyHazard,
  isFileWriteRedirect,
  isHeredocDataSinkPipeline,
  isShellOrSourceCommand,
  nextHeredocCwd,
  normalizeWrittenPath,
  quotedHeredocBodyIsDynamic,
  readExpansion,
  readHeredocBody,
  readHeredocDelimiter,
  resolveExecutionPath,
  teeDestinationPaths,
} from "./desktop-guard-heredoc.js";
import { quotedHeredocLifecycleHazard } from "./desktop-guard-quoted.js";
import {
  assignmentEntries,
  commandBaseAt,
  commandBasename,
  commandWritesActivateScript,
  externalAssignments,
  isActivateWriteTarget,
  isLiteralActivatePath,
  isUnsafeSource,
  literalCommandToken,
  primaryCommandIndex,
  SAFE_SHELL_CONTROL_OPS,
  SHELL_INTERPRETER_NAMES,
  STATIC_SHELL_EXPANSIONS,
  unresolvedVariableReason,
} from "./desktop-guard-words.js";
import { usesNativeShell } from "./native-shell.js";

type ShellSeparator = "pipe" | "and" | "or" | "seq" | "background";

type PreparedDesktopCommand =
  | { command: string; literals: Readonly<Record<string, string>> }
  | { reason: string };

type PendingHeredoc = {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
  names?: string[];
};

/**
 * Drop comments and quoted heredoc bodies, and substitute literal assignments.
 * Returns a short refusal when the command is dynamic in a way the later
 * tokenizer cannot see (quotes hiding a substitution, a heredoc that is not
 * data for cat or tee, a quoted body that names a lifecycle command, a shell,
 * source, sudo, or busybox after that heredoc, a later command that runs a
 * path that heredoc wrote, source of anything but a
 * literal activate path, or a write that can plant that activate script).
 */
function prepareDesktopGuardCommand(source: string): PreparedDesktopCommand {
  const env = new Map<string, string>();
  const literals: Record<string, string> = {};
  const usedKeys = new Set<string>();
  const pending: PendingHeredoc[] = [];
  let heredocConsumed = false;
  let heredocDynamic = false;
  const heredocDir: { cwd: string | undefined } = { cwd: "" };
  const heredocOutputs = new Set<string>();
  const pipelineWrites: string[] = [];
  let pipelineHasHeredoc = false;
  const simpleWrites: string[] = [];
  let pipelineNames: string[] = [];
  let commandWords: string[] = [];
  let out = "";
  let rawWord = "";
  let quote: "'" | '"' | undefined;
  let wordQuoted = false;
  let atWordStart = true;
  let redirectNext = false;
  let redirectOp = "";
  let activateWrite = false;
  // IFS changes how unquoted expansions split. Refuse instead of guessing the fields.
  let substituteLiterals = true;
  let guaranteed = true;
  let inPipeline = false;
  let index = 0;

  const finishWord = () => {
    if (rawWord.length === 0 && !wordQuoted) return;
    const raw = rawWord;
    rawWord = "";
    wordQuoted = false;
    atWordStart = true;
    if (redirectNext) {
      redirectNext = false;
      if (isActivateWriteTarget(redirectOp, raw, commandWords, env)) activateWrite = true;
      const target = literalCommandToken(raw);
      if (target && isFileWriteRedirect(redirectOp, target)) {
        simpleWrites.push(normalizeWrittenPath(target));
      }
      redirectOp = "";
      return;
    }
    commandWords.push(raw);
  };

  const forgetExternalAssignments = (words: readonly string[]) => {
    const assigned = externalAssignments(words);
    if (!assigned) return;
    if (assigned.clear) {
      substituteLiterals = false;
      env.clear();
      return;
    }
    for (const name of assigned.names) {
      env.delete(name);
      if (name === "IFS") substituteLiterals = false;
    }
  };

  const endSimple = (kind: ShellSeparator): string | undefined => {
    finishWord();
    const words = commandWords;
    commandWords = [];
    // Only sinks in this pipeline survive, so their redirects are the heredoc's output.
    // Resolve them in the directory this command runs in, before a later cd moves.
    if (pipelineHasHeredoc) {
      const placed = (path: string) => resolveExecutionPath(heredocDir.cwd, path);
      for (const path of simpleWrites) {
        const resolved = placed(path);
        if (resolved !== undefined) pipelineWrites.push(resolved);
      }
      for (const path of teeDestinationPaths(words)) {
        const resolved = placed(path);
        if (resolved !== undefined) pipelineWrites.push(resolved);
      }
    }
    simpleWrites.length = 0;
    // A pipeline or background cd runs in a subshell, so the parent directory stays.
    const commandIndex = primaryCommandIndex(words);
    if (
      kind !== "pipe" &&
      kind !== "background" &&
      !inPipeline &&
      commandIndex !== undefined &&
      commandBaseAt(words, commandIndex) === "cd"
    ) {
      heredocDir.cwd = nextHeredocCwd(heredocDir.cwd, words.slice(commandIndex + 1));
    }
    // Remember the write across a pending heredoc so a dangerous body can still
    // refuse as heredoc. A harmless body is refused once that body is consumed.
    if (activateWrite || commandWritesActivateScript(words, env)) activateWrite = true;
    if (activateWrite && pending.length === 0) return "activate script";
    if (
      heredocConsumed &&
      (isShellOrSourceCommand(words) ||
        executesWrittenHeredoc(words, heredocOutputs, heredocDynamic, heredocDir))
    ) {
      return "heredoc";
    }
    const guaranteedBefore = guaranteed;
    if (isUnsafeSource(words)) return "source";
    const base = commandBasename(words);
    if (base !== undefined) pipelineNames.push(base);
    const entries = assignmentEntries(words);
    if (entries?.some((entry) => entry.name === "IFS")) substituteLiterals = false;
    // A builtin, loop, or sourced script can replace a literal this command still trusts.
    forgetExternalAssignments(words);
    const pipeMember = inPipeline || kind === "pipe";
    if (!pipeMember && kind !== "background") {
      if (entries) {
        for (const entry of entries) {
          // A non-guaranteed write must not replace a value this command might still use.
          if (!guaranteedBefore || entry.value === null) env.delete(entry.name);
          else env.set(entry.name, entry.value);
        }
      }
    } else if (kind === "background") {
      for (const entry of entries ?? []) env.delete(entry.name);
    }
    if (kind === "pipe") {
      inPipeline = true;
      guaranteed = false;
      return undefined;
    }
    for (const heredoc of pending) {
      if (!heredoc.names) heredoc.names = [...pipelineNames];
    }
    pipelineNames = [];
    inPipeline = false;
    if (kind === "and") {
      const stable = assignmentEntries(words)?.every((entry) => entry.value !== null) ?? false;
      guaranteed = guaranteedBefore && stable && !pipeMember;
    } else if (kind === "or" || kind === "background") guaranteed = false;
    else guaranteed = true;
    if (pending.length === 0) {
      pipelineWrites.length = 0;
      pipelineHasHeredoc = false;
    }
    return undefined;
  };

  const appendExpansion = (): string | undefined => {
    const next = source[index + 1];
    if (next === "(") {
      return source[index + 2] === "(" ? "arithmetic expansion" : "command substitution";
    }
    const expansion = readExpansion(source, index);
    if (!expansion) {
      out += "$";
      rawWord += "$";
      index += 1;
      atWordStart = false;
      return undefined;
    }
    rawWord += expansion.raw;
    if (!expansion.simple) {
      const hazard = braceExpansionHazard(expansion.raw);
      if (hazard) return hazard;
      out += expansion.raw;
    } else {
      const value = env.get(expansion.name);
      if (value === undefined || !substituteLiterals) out += expansion.raw;
      else {
        const key = freshLiteralKey(source, usedKeys);
        literals[key] = value;
        out += `$${key}`;
      }
    }
    index = expansion.end;
    atWordStart = false;
    return undefined;
  };

  while (index < source.length) {
    const character = source[index];
    if (quote === "'") {
      out += character ?? "";
      rawWord += character ?? "";
      if (character === "'") quote = undefined;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") {
        const next = source[index + 1];
        out += character ?? "";
        rawWord += character ?? "";
        if (next !== undefined) {
          out += next;
          rawWord += next;
          index += 2;
          continue;
        }
      } else if (character === '"') {
        quote = undefined;
        out += character;
        rawWord += character;
      } else if (character === "`") return { reason: "backtick" };
      else if (character === "$") {
        const reason = appendExpansion();
        if (reason) return { reason };
        continue;
      } else {
        out += character ?? "";
        rawWord += character ?? "";
      }
      index += 1;
      continue;
    }
    if (character === "\\") {
      const next = source[index + 1];
      if (next === "\n") {
        index += 2;
        continue;
      }
      out += "\\";
      rawWord += "\\";
      atWordStart = false;
      if (next !== undefined) {
        out += next;
        rawWord += next;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      wordQuoted = true;
      atWordStart = false;
      out += character;
      rawWord += character;
      index += 1;
      continue;
    }
    if (character === "#" && atWordStart) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "#") {
      // shell-quote treats a mid-word # as a comment and drops the rest of the string.
      out += "\\#";
      rawWord += "#";
      atWordStart = false;
      index += 1;
      continue;
    }
    if (character === " " || character === "\t") {
      finishWord();
      out += character;
      atWordStart = true;
      index += 1;
      continue;
    }
    if (character === "\n") {
      const separated = endSimple("seq");
      if (separated) return { reason: separated };
      if (pending.length === 0) {
        out += "\n";
        atWordStart = true;
        index += 1;
        continue;
      }
      if (pending.some((heredoc) => !isHeredocDataSinkPipeline(heredoc.names ?? []))) {
        return { reason: "heredoc" };
      }
      let cursor = index + 1;
      for (const heredoc of pending) {
        const body = readHeredocBody(source, cursor, heredoc.delimiter, heredoc.stripTabs);
        if (!body) return { reason: "heredoc" };
        if (heredoc.quoted) {
          if (quotedHeredocLifecycleHazard(body.content)) return { reason: "heredoc" };
          if (quotedHeredocBodyIsDynamic(body.content)) heredocDynamic = true;
        } else {
          const hazard = heredocBodyHazard(body.content);
          if (hazard) return { reason: hazard };
          out += body.content;
        }
        cursor = body.end;
      }
      for (const path of pipelineWrites) heredocOutputs.add(path);
      pipelineWrites.length = 0;
      pipelineHasHeredoc = false;
      pending.length = 0;
      heredocConsumed = true;
      out += "\n";
      atWordStart = true;
      index = cursor;
      continue;
    }
    if (character === "<" && source.startsWith("<<<", index)) return { reason: "herestring" };
    if (character === "<" && source[index + 1] === "<") {
      finishWord();
      let cursor = index + 2;
      const stripTabs = source[cursor] === "-";
      if (stripTabs) cursor += 1;
      const delimiter = readHeredocDelimiter(source, cursor);
      if (!delimiter) return { reason: "heredoc" };
      // Quoted delimiters suppress expansion. Unquoted bodies still expand, so they are scanned below.
      pending.push({ delimiter: delimiter.delimiter, quoted: delimiter.quoted, stripTabs });
      pipelineHasHeredoc = true;
      index = delimiter.end;
      atWordStart = true;
      continue;
    }
    if ((character === "<" || character === ">") && source[index + 1] === "(") {
      return { reason: "subshell" };
    }
    if (character === "`") return { reason: "backtick" };
    if (character === "$") {
      const reason = appendExpansion();
      if (reason) return { reason };
      continue;
    }
    if (character === "(" || character === ")") return { reason: "subshell" };
    const multi = ["&&", "||", ";;", "|&", ">>", ">&", "<&", "&>"].find((op) =>
      source.startsWith(op, index),
    );
    if (
      multi ||
      character === ";" ||
      character === "|" ||
      character === "&" ||
      character === ">" ||
      character === "<"
    ) {
      const op = multi ?? character ?? "";
      const redirect =
        op === ">" || op === "<" || op === ">>" || op === ">&" || op === "<&" || op === "&>";
      if (redirect && !wordQuoted && /^\d+$/.test(rawWord)) {
        rawWord = "";
        atWordStart = true;
      }
      if (redirect) {
        finishWord();
        out += op;
        atWordStart = true;
        redirectOp = op;
        redirectNext = true;
        index += op.length;
        continue;
      }
      // The redirect target is still the current word. Consume it before this
      // separator clears the redirect, or `> path;` is inspected as an argument.
      if (redirectNext) finishWord();
      out += op;
      atWordStart = true;
      redirectNext = false;
      index += op.length;
      const kind: ShellSeparator =
        op === "|" || op === "|&"
          ? "pipe"
          : op === "&&"
            ? "and"
            : op === "||"
              ? "or"
              : op === "&"
                ? "background"
                : "seq";
      const separated = endSimple(kind);
      if (separated) return { reason: separated };
      continue;
    }
    out += character ?? "";
    rawWord += character ?? "";
    atWordStart = false;
    index += 1;
  }

  const separated = endSimple("seq");
  if (separated) return { reason: separated };
  if (quote || pending.length > 0)
    return { reason: quote ? "uninspectable shell syntax" : "heredoc" };
  return { command: out, literals };
}

function shellCFlagProgram(words: readonly string[], interpreterIndex: number): string | undefined {
  for (let index = interpreterIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word.startsWith("--command=")) return word.slice("--command=".length);
    // bash -c / -lc / -ce and fish --command: the next argument is the program string.
    if (word === "--command" || /^-[^-]*c/.test(word)) return words[index + 1];
  }
  return undefined;
}

function preserveShellCommandBoundaries(command: string): string {
  let quote: "'" | '"' | undefined;
  let result = "";
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];
    if (character === "\\" && quote !== "'") {
      if (next === "\n") {
        index += 1;
        continue;
      }
      // Keep escaped characters intact; an escaped quote is not a boundary.
      result += character;
      if (next !== undefined) {
        result += next;
        index += 1;
      }
      continue;
    }
    if (character === quote) quote = undefined;
    else if (!quote && (character === "'" || character === '"')) quote = character;
    result += character === "\n" && !quote ? "\n;" : character;
  }
  return result;
}

function shellTokenReason(entry: object): string | undefined {
  if ("comment" in entry) return "comment";
  if ("expansion" in entry && typeof entry.expansion === "string") {
    const hazard = braceExpansionHazard(entry.expansion);
    // The value is chosen by the shell after this guard, so it cannot be checked.
    return hazard ?? unresolvedVariableReason(entry.expansion);
  }
  if (!("op" in entry) || typeof entry.op !== "string") return "uninspectable shell syntax";
  if (entry.op === "glob") return undefined;
  if (entry.op === "(" || entry.op === ")" || entry.op === "<(") return "subshell";
  if (entry.op === "<<<") return "herestring";
  if (SAFE_SHELL_CONTROL_OPS.has(entry.op)) return undefined;
  return "unsupported shell syntax";
}

function tokenizeProtectedShellCommand(
  command: string,
  literals: Readonly<Record<string, string>>,
): { words: string[] } | { reason: string } {
  try {
    // shell-quote treats newlines as whitespace. Preserve command boundaries for
    // the dot builtin, after folding shell line continuations.
    const separated = preserveShellCommandBoundaries(command);
    const parsed = parseShellCommand<{ expansion: string }>(
      separated,
      (name) => literals[name] ?? STATIC_SHELL_EXPANSIONS[name] ?? { expansion: name },
      { splitUnquoted: true },
    );
    const words: string[] = [];
    let commandPosition = true;
    let redirectTarget = false;
    for (const [index, entry] of parsed.entries()) {
      if (typeof entry === "string") {
        // Backtick fragments are not fully tokenized; treat them as dynamic.
        if (entry.includes("`")) return { reason: "backtick" };
        const folded = entry.toLowerCase();
        // `find .`, `git add .`, and `git -C .` use a path, not the
        // executable `. script` builtin. Keep the path out of the builtin scan.
        words.push(entry === "." && (!commandPosition || redirectTarget) ? "./" : entry);
        if (redirectTarget) {
          redirectTarget = false;
          continue;
        }
        const next = parsed[index + 1];
        if (
          commandPosition &&
          /^\d+$/.test(folded) &&
          typeof next === "object" &&
          next !== null &&
          "op" in next &&
          /^[<>]/.test(next.op)
        ) {
          // A leading file descriptor belongs to a redirect, not the command.
        } else if (commandPosition && /^(?:then|do|else)$/.test(folded)) {
          commandPosition = true;
        } else if (commandPosition && (folded === "coproc" || folded === "function")) {
          return { reason: folded };
        } else if (
          commandPosition &&
          (/^(?:command|builtin|exec|time|if|elif|while|until|!|\{)$/.test(folded) ||
            folded.startsWith("-") ||
            /^[a-z_][a-z0-9_]*=/.test(folded))
        ) {
          // Shell prefixes and assignments leave the command word pending.
        } else commandPosition = false;
        continue;
      }
      if (typeof entry !== "object" || entry === null)
        return { reason: "uninspectable shell syntax" };
      if (
        "op" in entry &&
        entry.op === "glob" &&
        "pattern" in entry &&
        typeof entry.pattern === "string"
      ) {
        words.push(entry.pattern);
        continue;
      }
      const reason = shellTokenReason(entry);
      if (reason) return { reason };
      if ("op" in entry && typeof entry.op === "string" && SAFE_SHELL_CONTROL_OPS.has(entry.op)) {
        if (["&&", "||", ";", "|", "&"].includes(entry.op)) {
          commandPosition = true;
          redirectTarget = false;
        } else redirectTarget = true;
      }
    }
    return { words };
  } catch {
    return { reason: "uninspectable shell syntax" };
  }
}

function protectedWordRefusal(words: readonly string[]): string | undefined {
  for (const word of words) {
    const base = (word.split("/").at(-1) ?? "").toLowerCase();
    if (/^(?:kill|pkill|killall|xkill)$/.test(base)) return `protected command ${base}`;
  }
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const base = (word.split("/").at(-1) ?? "").toLowerCase();
    if (base !== "eval" && base !== "source" && word !== ".") continue;
    const next = words[index + 1];
    // Virtualenv activation is the one source form that does not run an arbitrary script.
    if ((word === "source" || word === ".") && next && isLiteralActivatePath(next)) continue;
    return base === "eval" ? "eval" : "source";
  }
  const service = words
    .map((word) => (word.split("/").at(-1) ?? "").toLowerCase())
    .find((word) => word === "systemctl" || word === "service");
  if (service) {
    const action = words.find((word) => /^(?:stop|restart|kill)$/.test(word.toLowerCase()));
    if (action) return `${service} ${action.toLowerCase()}`;
  }
  for (const word of words) {
    const folded = word.toLowerCase();
    if (/(?:\.browser-profiles|--user-data-dir)/.test(folded)) return "browser profile path";
    if (/(?:\/tmp\/\.x11-unix|\/tmp\/\.x\d+-lock)/.test(folded)) return "X11 path";
  }
  for (let index = 0; index < words.length; index += 1) {
    const name = (words[index]?.split("/").at(-1) ?? "").toLowerCase();
    if (!SHELL_INTERPRETER_NAMES.test(name)) continue;
    const program = shellCFlagProgram(words, index);
    if (!program) continue;
    const nested = protectedComputerLifecycleRefusal(program);
    if (nested) return nested;
  }
  return undefined;
}

/** Short reason the desktop-protection guard refuses `command`, when it does. */
export function protectedComputerLifecycleRefusal(command: string): string | undefined {
  const prepared = prepareDesktopGuardCommand(command);
  if ("reason" in prepared) return prepared.reason;
  const tokenized = tokenizeProtectedShellCommand(prepared.command, prepared.literals);
  if ("reason" in tokenized) return tokenized.reason;
  return protectedWordRefusal(tokenized.words);
}

/** Whether commands reach the Linux desktop this guard protects rather than a native shell. */
export function desktopGuardApplies(computer: {
  graphical: boolean;
  stored: { kind: string };
  kind?: string;
  lazy?: { ready?: { kind: string } };
}) {
  if (!computer.graphical) return false;
  // Before the run starts its computer it may reuse the one it has or start the new kind, so
  // guard unless both have a native shell.
  const kinds = computer.lazy?.ready
    ? [computer.lazy.ready.kind]
    : [computer.stored.kind, computer.kind ?? computer.stored.kind];
  return kinds.some((kind) => !usesNativeShell(kind));
}

export function isProtectedComputerLifecycleCommand(command: string): boolean {
  return protectedComputerLifecycleRefusal(command) !== undefined;
}

export function desktopProtectionGuardMessage(reason: string): string {
  const recovery =
    reason === "heredoc"
      ? " For ordinary file edits, use the file tools or python3 -c with a quoted script instead of an interpreter heredoc. This refusal does not indicate a filesystem permission error."
      : reason === "command substitution" || reason === "backtick"
        ? " For HTTP authentication, use the client's auth support or python3 -c reading the saved command credential from os.environ. Never print credentials. No request ran, so this refusal does not indicate invalid credentials."
        : "";
  return `This command was not run: desktop-protection guard: ${reason}. Shell access is still available.${recovery} Do not stop or restart browser or desktop processes.`;
}
