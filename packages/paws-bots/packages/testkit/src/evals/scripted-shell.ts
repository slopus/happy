// Pure command scripting for eval computers. It must not import runtime packages: listing eval
// cases loads it before the database client is generated.

/** What a scripted check prints and how it exits; a failing check prints to stderr. */
export interface ScriptedCheck {
  match: RegExp;
  output: string;
  /** Defaults to 0. */
  exitCode?: number;
  /** Matches the whole command, pipes included, for a pipeline whose output can't be derived. */
  whole?: true;
}

/**
 * The state of an eval computer, for cases where the bot may check its own earlier work. Shell
 * commands get output consistent with that state; screenshots show its browser window.
 */
export interface ComputerScript {
  /**
   * Checks the computer answers, most specific first: each command answers with the first one
   * it matches. A command none of them matches stays unavailable, as without a script.
   */
  shell: ScriptedCheck[];
  /** The browser window screenshots show: its title and whether its page renders dark. */
  screen: { title: string; dark: boolean };
}

/** Shell syntax this script cannot follow command by command (loops, substitutions, scripts). */
const COMPOUND =
  /\b(?:for|while|until|if|case|function)\b|\$\(|`|\b(?:python3?|node|perl|awk|sh|bash)\b/;
const SILENCED = /2>\s*\/dev\/null|2>&-|&>\s*\/dev\/null/;
/** `>`, `>>`, `1>` or `&>` send stdout elsewhere; `2>` only moves stderr. */
const STDOUT_REDIRECT = /(?<![2>])>(?!&2)/;

/**
 * What the script answers for a shell command, or undefined when it covers none of it. A plain
 * command list (`;`, `&&`, `||`) runs command by command, so one unscripted command makes the
 * whole list unavailable; `echo` prints its words. Loops and inline scripts get the answers to
 * the checks they mention, in the order they mention them.
 */
export function scriptedShell(
  script: ComputerScript,
  command: string,
): { stdout: string; stderr: string; code: number } | undefined {
  const out: string[] = [];
  const err: string[] = [];
  // `segment` is the command text a check answers for: its redirects decide what is shown.
  const emit = (check: ScriptedCheck, segment: string) => {
    const code = check.exitCode ?? 0;
    if (!check.output) return code;
    if (code === 0) {
      if (!STDOUT_REDIRECT.test(segment)) out.push(check.output);
    } else if (!SILENCED.test(segment)) err.push(check.output);
    return code;
  };
  if (COMPOUND.test(command)) {
    // A more specific check answers where it matches; a general one only where it alone does.
    const found: Array<{ check: ScriptedCheck; at: number }> = [];
    for (const check of script.shell) {
      const at = command.search(check.match);
      if (at >= 0 && !found.some((earlier) => earlier.at === at)) found.push({ check, at });
    }
    found.sort((a, b) => a.at - b.at);
    if (!found.length) return undefined;
    // Each check is silenced only by a redirect before the next check, not by one elsewhere.
    const codes = found.map(({ check, at }, index) =>
      emit(check, command.slice(at, found[index + 1]?.at ?? command.length)),
    );
    return { stdout: out.join("\n"), stderr: err.join("\n"), code: codes.at(-1)! };
  }
  // Subshell parentheses only group a list here; `cd` changes nothing the checks answer.
  const parts = splitOutsideQuotes(command, /^(?:&&|\|\||;|\n)/).map((part, index) =>
    index % 2
      ? part
      : part
          .trim()
          .replace(/^\(\s*/, "")
          .replace(/\s*\)((?:\s*[0-9&]?>&?\s*\S+)*)\s*$/, "$1"),
  );
  let code = 0;
  // `cd` changes nothing a check answers, except what a bare file name after it means.
  let directory = "";
  for (let index = 0; index < parts.length; index += 2) {
    const typed = parts[index]!.trim();
    const part = directory
      ? typed.replace(
          /(^|\s)(?![~/$-])(?:\.\/)?([\w@-][\w.@-]*\.(?:json|md|csv|txt|log))\b/g,
          (_, space: string, file: string) => `${space}${directory}/${file}`,
        )
      : typed;
    const operator = parts[index - 1];
    if (!part || (operator === "&&" && code !== 0) || (operator === "||" && code === 0)) continue;
    const cd = /^cd(?:\s+(\S+))?(?:\s+[0-9&]?>\S*)*$/.exec(part);
    if (cd) {
      directory = (cd[1] ?? "").replace(/\/$/, "");
      code = 0;
      continue;
    }
    const echo = /^echo(?:\s+(?:-[en]+\s+)?(.*))?$/s.exec(
      part.replace(/\s*(?:[0-9&]?>|\|).*$/s, ""),
    );
    if (echo) {
      // `echo … > file` writes to the file, so nothing reaches stdout.
      if (!STDOUT_REDIRECT.test(part))
        out.push((echo[1] ?? "").replace(/^(["'])(.*)\1$/s, "$2").replaceAll("$?", String(code)));
      code = 0;
      continue;
    }
    const wholeCheck = script.shell.find((entry) => entry.whole && entry.match.test(part));
    if (wholeCheck) {
      code = emit(wholeCheck, part);
      continue;
    }
    // `a | grep b` filters a's output; any other pipe is a program the script cannot run.
    const [head, ...pipes] = splitOutsideQuotes(part, /^\|(?!\|)/)
      .filter((_, at) => at % 2 === 0)
      .map((piece) => piece.trim());
    const check = script.shell.find((entry) => entry.match.test(head!));
    if (!check) return undefined;
    if (!pipes.length) {
      code = emit(check, part);
      continue;
    }
    const failed = (check.exitCode ?? 0) !== 0;
    if (failed && check.output && !SILENCED.test(head!)) err.push(check.output);
    let text = failed ? "" : (check.output ?? "");
    for (const pipe of pipes) {
      const filtered = pipeFilter(pipe.replace(/\s*(?:[0-9&]?>).*$/s, ""), text);
      if (!filtered) return undefined;
      ({ text, code } = filtered);
    }
    if (text && !STDOUT_REDIRECT.test(pipes.at(-1)!)) out.push(text);
  }
  return { stdout: out.join("\n"), stderr: err.join("\n"), code };
}

/**
 * Splits at operators that are not inside quotes or escaped, keeping each operator between the
 * pieces: `grep -E "a|b" f | head` has one pipe, not two.
 */
function splitOutsideQuotes(command: string, operator: RegExp): string[] {
  const pieces: string[] = [];
  let quote = "";
  let start = 0;
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (char === "\\" && quote !== "'") {
      at++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const found = operator.exec(command.slice(at))?.[0];
    if (!found) continue;
    pieces.push(command.slice(start, at), found);
    at += found.length - 1;
    start = at + 1;
  }
  pieces.push(command.slice(start));
  return pieces;
}

/** `head`, `tail` or `grep` over piped text; anything else is undefined. */
function pipeFilter(command: string, text: string): { text: string; code: number } | undefined {
  const columns = /^cut\s+(?:-c\s*(\d+)?-(\d+)?|-d\s*(["']?)(.)\3\s+-f\s*(\d+))$/.exec(
    command.trim(),
  );
  if (columns) {
    const [, from, to, , separator, field] = columns;
    const lines = text
      .split("\n")
      .map((line) =>
        separator
          ? (line.split(separator)[Number(field) - 1] ?? "")
          : line.slice(from ? Number(from) - 1 : 0, to ? Number(to) : undefined),
      );
    return { text: lines.join("\n"), code: 0 };
  }
  const cut = /^(head|tail)(?:\s+-(?:(n)\s*|(c)\s*)?(\d+))?$/.exec(command.trim());
  if (!cut) return grepFilter(command, text);
  const [, which, , bytes, count] = cut;
  const n = count === undefined ? 10 : Number(count);
  if (bytes) return { text: which === "head" ? text.slice(0, n) : text.slice(-n), code: 0 };
  const lines = text.split("\n");
  return { text: (which === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n"), code: 0 };
}

/** `grep` over piped text with the flags checks commonly use; anything else is undefined. */
function grepFilter(command: string, text: string): { text: string; code: number } | undefined {
  const parsed = /^grep\s+((?:-[iovqcEF]+\s+)*)(?:(["'])(.*)\2|(\S+))$/s.exec(command.trim());
  if (!parsed) return undefined;
  const flags = parsed[1] ?? "";
  const pattern = parsed[3] ?? parsed[4]!;
  let regex: RegExp;
  try {
    const source = flags.includes("F")
      ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : flags.includes("E")
        ? pattern
        : // Basic regular expressions spell alternation `\|`.
          pattern.replace(/\\\|/g, "|");
    regex = new RegExp(source, flags.includes("i") ? "i" : "");
  } catch {
    return undefined;
  }
  const invert = flags.includes("v");
  const lines = text.split("\n").filter((line) => line && regex.test(line) !== invert);
  const code = lines.length ? 0 : 1;
  if (flags.includes("q")) return { text: "", code };
  if (flags.includes("c")) return { text: String(lines.length), code };
  if (flags.includes("o") && !invert)
    return { text: lines.map((line) => line.match(regex)![0]).join("\n"), code };
  return { text: lines.join("\n"), code };
}
