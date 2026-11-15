import { skipPlainParameter } from "./desktop-guard-heredoc.js";

function matchingBrace(body: string, openIndex: number): number | undefined {
  let depth = 1;
  let index = openIndex + 1;
  while (index < body.length) {
    const character = body[index];
    if (character === "'") {
      const end = body.indexOf("'", index + 1);
      if (end === -1) return undefined;
      index = end + 1;
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < body.length && body[index] !== '"') {
        if (body[index] === "\\" && index + 1 < body.length) index += 2;
        else index += 1;
      }
      if (index >= body.length) return undefined;
      index += 1;
      continue;
    }
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return undefined;
}

function matchingParen(body: string, openIndex: number): number | undefined {
  let depth = 1;
  let index = openIndex + 1;
  while (index < body.length) {
    const character = body[index];
    if (character === "'") {
      const end = body.indexOf("'", index + 1);
      if (end === -1) return undefined;
      index = end + 1;
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < body.length && body[index] !== '"') {
        if (body[index] === "\\" && index + 1 < body.length) index += 2;
        else index += 1;
      }
      if (index >= body.length) return undefined;
      index += 1;
      continue;
    }
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return undefined;
}

/** Literal text of a double-quoted span, plus command-substitution interiors. */
function readDoubleQuoted(
  body: string,
  start: number,
): { end: number; literal: string; dynamic: boolean; interiors: string[] } | undefined {
  let literal = "";
  let dynamic = false;
  const interiors: string[] = [];
  let index = start;
  while (index < body.length) {
    const character = body[index];
    if (character === '"') {
      if (dynamic && literal.length > 0) return undefined;
      return { end: index + 1, literal: dynamic ? "" : literal, dynamic, interiors };
    }
    if (character === "\\") {
      const next = body[index + 1];
      if (next === undefined) return undefined;
      literal += next;
      index += 2;
      continue;
    }
    if (character === "`") return undefined;
    if (character === "$" && body[index + 1] === "(") {
      if (body[index + 2] === "(") return undefined;
      const close = matchingParen(body, index + 1);
      if (close === undefined) return undefined;
      interiors.push(body.slice(index + 2, close));
      dynamic = true;
      index = close + 1;
      continue;
    }
    if (character === "$") {
      dynamic = true;
      if (body[index + 1] === "{") {
        const close = body.indexOf("}", index + 2);
        if (close === -1) return undefined;
        index = close + 1;
        continue;
      }
      if (/[A-Za-z_]/.test(body[index + 1] ?? "")) {
        index += 2;
        while (index < body.length && /[A-Za-z0-9_]/.test(body[index] ?? "")) index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    literal += character ?? "";
    index += 1;
  }
  return undefined;
}

/**
 * Shell words of a quoted heredoc body. Adjacent quotes concatenate, so
 * `pk''ill` is `pkill`. Undefined when a word's text cannot be known.
 */
function quotedHeredocWords(body: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let active = false;
  const commit = () => {
    if (!active) return;
    words.push(word);
    word = "";
    active = false;
  };
  let index = 0;
  while (index < body.length) {
    const character = body[index] ?? "";
    if (!active && character === "#") {
      const newline = body.indexOf("\n", index);
      index = newline === -1 ? body.length : newline + 1;
      continue;
    }
    if (character === "'") {
      const end = body.indexOf("'", index + 1);
      if (end === -1) return undefined;
      word += body.slice(index + 1, end);
      active = true;
      index = end + 1;
      continue;
    }
    if (character === '"') {
      const quoted = readDoubleQuoted(body, index + 1);
      if (!quoted) return undefined;
      if (quoted.dynamic && quoted.literal.length > 0) return undefined;
      if (quoted.dynamic) {
        for (const interior of quoted.interiors) {
          const inner = quotedHeredocWords(interior);
          if (!inner) return undefined;
          words.push(...inner);
        }
        index = quoted.end;
        continue;
      }
      word += quoted.literal;
      active = true;
      index = quoted.end;
      continue;
    }
    if (character === "\\") {
      const next = body[index + 1];
      if (next === undefined) return undefined;
      if (next !== "\n") {
        word += next;
        active = true;
      }
      index += 2;
      continue;
    }
    if (character === "`") return undefined;
    if (character === "$" && (body[index + 1] === "'" || body[index + 1] === '"')) {
      return undefined;
    }
    if (character === "$" && body[index + 1] === "(") {
      if (body[index + 2] === "(" || active) return undefined;
      const close = matchingParen(body, index + 1);
      if (close === undefined) return undefined;
      const inner = quotedHeredocWords(body.slice(index + 2, close));
      if (!inner) return undefined;
      words.push(...inner);
      index = close + 1;
      continue;
    }
    if (character === "$") {
      // A parameter glued to literals (`pk$ill`, `$a'pkill'`) hides the word.
      if (active) return undefined;
      const end = skipPlainParameter(body, index);
      if (end === undefined) return undefined;
      const next = body[end] ?? "";
      if (next !== "" && !" \t\n;&|<>(){}".includes(next)) return undefined;
      index = end;
      continue;
    }
    if (" \t\n;&|<>(){}".includes(character)) {
      if (character === "<" && body[index + 1] === "(") return undefined;
      // `{pk,ill}` is brace expansion. A brace group is `{` then a separator.
      if (
        character === "{" &&
        body[index + 1] !== undefined &&
        !" \t\n;&|<>(){}".includes(body[index + 1] ?? "")
      ) {
        return undefined;
      }
      commit();
      index += 1;
      continue;
    }
    word += character;
    active = true;
    index += 1;
  }
  commit();
  return words;
}

function wordsHaveLifecycleHazard(words: readonly string[]): boolean {
  let sawService = false;
  let sawServiceAction = false;
  for (const word of words) {
    const folded = word.toLowerCase();
    if (/(?:\.browser-profiles|--user-data-dir)/.test(folded)) return true;
    if (/(?:\/tmp\/\.x11-unix|\/tmp\/\.x\d+-lock)/.test(folded)) return true;
    const base = folded.split("/").at(-1) ?? "";
    if (/^(?:kill|pkill|killall|xkill)$/.test(base)) return true;
    if (base === "systemctl" || base === "service") sawService = true;
    if (/^(?:stop|restart|kill)$/.test(base)) sawServiceAction = true;
  }
  return sawService && sawServiceAction;
}

/** Drop quotes, backslashes, and `$`, and skip a `#` comment that starts a word. */
function normalizedHeredocWords(body: string): string[] {
  let text = "";
  let quote: "'" | '"' | undefined;
  let atWordStart = true;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? "";
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character !== "\\" && character !== "$") {
        text += character;
        atWordStart = false;
      }
      continue;
    }
    if (atWordStart && character === "#") {
      const newline = body.indexOf("\n", index);
      index = newline === -1 ? body.length : newline;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\" || character === "$") continue;
    if (character === " " || character === "\t" || character === "\n") atWordStart = true;
    else atWordStart = false;
    text += character;
  }
  return text.split(/[\s;&|<>(){}]+/).filter((word) => word.length > 0);
}

/**
 * A quoted body is data. Refuse when a lifecycle word is visible, including one
 * assembled across a command substitution (`p$(printf k)ill`). A later shell
 * call would run that file without seeing this body.
 */
export function quotedHeredocLifecycleHazard(body: string): boolean {
  const words = quotedHeredocWords(body);
  if (words && wordsHaveLifecycleHazard(words)) return true;
  if (wordsHaveLifecycleHazard(normalizedHeredocWords(body))) return true;
  return splicedLifecycleHazard(body);
}

type SplicePiece = { segments: string[]; holes: string[][] };

const SPLICE_SOLO_COMMANDS = ["kill", "pkill", "killall", "xkill"];

const SPLICE_SERVICE_COMMANDS = ["systemctl", "service"];

const SPLICE_PATHS = [".browser-profiles", "--user-data-dir", "/tmp/.x11-unix"];

function affixMatches(first: string, last: string, value: string): boolean {
  return (
    value.length > first.length + last.length && value.startsWith(first) && value.endsWith(last)
  );
}

/** `p$(…)ill` still names `pkill` when the hole's output is not a visible literal. */
function spliceAffixKind(piece: SplicePiece): "solo" | "service" | undefined {
  if (piece.holes.length === 0) return undefined;
  const first = (piece.segments[0] ?? "").toLowerCase();
  const last = (piece.segments[piece.segments.length - 1] ?? "").toLowerCase();
  if (first.length === 0 || last.length === 0) return undefined;
  if (SPLICE_SOLO_COMMANDS.some((name) => affixMatches(first, last, name))) return "solo";
  if (SPLICE_PATHS.some((path) => affixMatches(first, last, path))) return "solo";
  if (first === "/tmp/.x" && last === "-lock") return "solo";
  if (SPLICE_SERVICE_COMMANDS.some((name) => affixMatches(first, last, name))) return "service";
  return undefined;
}

function pieceCandidates(piece: SplicePiece): { words: string[]; overflow: boolean } {
  if (piece.holes.length === 0) {
    const word = piece.segments[0] ?? "";
    return { words: word.length > 0 ? [word] : [], overflow: false };
  }
  const limit = 48;
  let current = [piece.segments[0] ?? ""];
  let overflow = false;
  for (let hole = 0; hole < piece.holes.length; hole += 1) {
    const inserts = piece.holes[hole] ?? [""];
    const tail = piece.segments[hole + 1] ?? "";
    const next: string[] = [];
    for (const prefix of current) {
      for (const insert of inserts) {
        if (next.length >= limit) {
          overflow = true;
          break;
        }
        next.push(`${prefix}${insert}${tail}`);
      }
      if (overflow) break;
    }
    current = next;
    if (overflow) break;
  }
  return { words: current.filter((word) => word.length > 0), overflow };
}

function substitutionInserts(interior: string, depth: number): string[] {
  if (depth > 6) return [""];
  const inserts = new Set<string>([""]);
  const parsed = quotedHeredocWords(interior);
  for (const word of parsed ?? normalizedHeredocWords(interior)) inserts.add(word);
  const nested = splicePieces(interior, depth + 1);
  if (!nested) return [...inserts];
  for (const piece of nested) {
    for (const word of pieceCandidates(piece).words) inserts.add(word);
  }
  return [...inserts];
}

/** Shell words of a quoted body, with command-substitution holes kept in place. */
function splicePieces(body: string, depth = 0): SplicePiece[] | undefined {
  if (depth > 6) return undefined;
  const pieces: SplicePiece[] = [];
  let segments = [""];
  let holes: string[][] = [];
  let active = false;
  const commit = () => {
    if (active || holes.length > 0) pieces.push({ segments, holes });
    segments = [""];
    holes = [];
    active = false;
  };
  const append = (text: string) => {
    if (text.length === 0) return;
    segments[segments.length - 1] = `${segments[segments.length - 1] ?? ""}${text}`;
    active = true;
  };
  const addHole = (inserts: readonly string[]) => {
    holes.push([...inserts]);
    segments.push("");
    active = true;
  };
  const expansionAt = (
    start: number,
  ): { end: number; inserts: string[] } | "literal" | undefined => {
    const next = body[start + 1];
    if (next !== "(") return "literal";
    const close = matchingParen(body, start + 1);
    if (close === undefined) return undefined;
    const interior = body.slice(start + 2, close);
    if (next === "(" && body[start + 2] === "(") {
      return { end: close + 1, inserts: ["", ...normalizedHeredocWords(interior)] };
    }
    return { end: close + 1, inserts: substitutionInserts(interior, depth + 1) };
  };
  const backtickAt = (start: number): { end: number; inserts: string[] } | undefined => {
    let cursor = start + 1;
    let interior = "";
    while (cursor < body.length) {
      const character = body[cursor] ?? "";
      if (character === "\\" && cursor + 1 < body.length) {
        interior += body[cursor + 1] ?? "";
        cursor += 2;
        continue;
      }
      if (character === "`") {
        return { end: cursor + 1, inserts: substitutionInserts(interior, depth + 1) };
      }
      interior += character;
      cursor += 1;
    }
    return undefined;
  };
  const parameterAt = (start: number): { end: number } | undefined => {
    const next = body[start + 1];
    if (next === "{") {
      const match = /^\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(body.slice(start + 1));
      if (match) return { end: start + 1 + match[0].length };
      const close = matchingBrace(body, start + 1);
      if (close === undefined) return undefined;
      return { end: close + 1 };
    }
    if (next && /[A-Za-z_]/.test(next)) {
      let cursor = start + 2;
      while (cursor < body.length && /[A-Za-z0-9_]/.test(body[cursor] ?? "")) cursor += 1;
      return { end: cursor };
    }
    if (next && /[0-9*@#?$!-]/.test(next)) return { end: start + 2 };
    return undefined;
  };

  const finish = (): SplicePiece[] => {
    commit();
    return pieces;
  };
  let index = 0;
  let quote: "'" | '"' | undefined;
  while (index < body.length) {
    const character = body[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else append(character);
      index += 1;
      continue;
    }
    if (character === "\\") {
      const next = body[index + 1];
      if (next === undefined) return finish();
      if (next !== "\n") append(next);
      index += 2;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
        index += 1;
        continue;
      }
      if (character === "`") {
        const tick = backtickAt(index);
        if (!tick) return finish();
        addHole(tick.inserts);
        index = tick.end;
        continue;
      }
      if (character === "$" && body[index + 1] === "(") {
        const expansion = expansionAt(index);
        if (expansion === undefined || expansion === "literal") return finish();
        addHole(expansion.inserts);
        index = expansion.end;
        continue;
      }
      if (character === "$") {
        const parameter = parameterAt(index);
        if (!parameter) return finish();
        addHole([""]);
        index = parameter.end;
        continue;
      }
      append(character);
      index += 1;
      continue;
    }
    if (!active && holes.length === 0 && (segments[0] ?? "") === "" && character === "#") {
      const newline = body.indexOf("\n", index);
      index = newline === -1 ? body.length : newline + 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      active = true;
      index += 1;
      continue;
    }
    if (character === "`") {
      const tick = backtickAt(index);
      if (!tick) return finish();
      addHole(tick.inserts);
      index = tick.end;
      continue;
    }
    if (character === "$" && body[index + 1] === "(") {
      const expansion = expansionAt(index);
      if (expansion === undefined || expansion === "literal") return finish();
      addHole(expansion.inserts);
      index = expansion.end;
      continue;
    }
    if (character === "$") {
      const parameter = parameterAt(index);
      if (!parameter) {
        append("$");
        index += 1;
        continue;
      }
      addHole([""]);
      index = parameter.end;
      continue;
    }
    if (" \t\n;&|<>(){}".includes(character)) {
      commit();
      index += 1;
      continue;
    }
    append(character);
    index += 1;
  }
  return finish();
}

function kmpFailure(target: string): number[] {
  const failure = Array<number>(target.length).fill(0);
  let matched = 0;
  for (let index = 1; index < target.length; index += 1) {
    while (matched > 0 && target[index] !== target[matched]) matched = failure[matched - 1] ?? 0;
    if (target[index] === target[matched]) {
      matched += 1;
      failure[index] = matched;
    }
  }
  return failure;
}

function kmpStep(
  state: number,
  character: string,
  target: string,
  failure: readonly number[],
): number {
  let next = state;
  while (next > 0 && (next === target.length || target[next] !== character)) {
    next = failure[next - 1] ?? 0;
  }
  if (target[next] === character) next += 1;
  return next;
}

function foldedSplice(piece: SplicePiece): { segments: string[]; holes: string[][] } {
  return {
    segments: piece.segments.map((segment) => segment.toLowerCase()),
    holes: piece.holes.map((inserts) => inserts.map((insert) => insert.toLowerCase())),
  };
}

/** Some combination of the visible hole texts is exactly `target`. */
function spliceEquals(
  segments: readonly string[],
  holes: readonly (readonly string[])[],
  target: string,
): boolean {
  let positions = new Set<number>();
  const first = segments[0] ?? "";
  if (target.startsWith(first)) positions.add(first.length);
  for (let hole = 0; hole < holes.length; hole += 1) {
    const segment = segments[hole + 1] ?? "";
    const next = new Set<number>();
    for (const position of positions) {
      for (const insert of holes[hole] ?? [""]) {
        if (!target.startsWith(insert, position)) continue;
        const after = position + insert.length;
        if (target.startsWith(segment, after)) next.add(after + segment.length);
      }
    }
    positions = next;
    if (positions.size === 0) return false;
  }
  return positions.has(target.length);
}

/**
 * Walks every combination without building it. `contains` is a hit anywhere;
 * `ends` means some combination ends with `target`.
 */
function scanSpliceTarget(
  segments: readonly string[],
  holes: readonly (readonly string[])[],
  target: string,
): { contains: boolean; ends: boolean } {
  const failure = kmpFailure(target);
  let states = new Set<number>([0]);
  let contains = false;
  const apply = (text: string) => {
    for (const character of text) {
      const next = new Set<number>();
      for (const state of states) {
        const stepped = kmpStep(state, character, target, failure);
        if (stepped === target.length) contains = true;
        next.add(stepped);
      }
      states = next;
    }
  };
  apply(segments[0] ?? "");
  for (let index = 0; index < holes.length; index += 1) {
    const start = states;
    const merged = new Set<number>();
    for (const insert of holes[index] ?? [""]) {
      states = new Set(start);
      apply(insert);
      for (const state of states) merged.add(state);
    }
    states = merged;
    apply(segments[index + 1] ?? "");
  }
  return { contains, ends: states.has(target.length) };
}

const X_LOCK_PREFIX = "/tmp/.x";

const X_LOCK_SUFFIX = "-lock";

function consumeXLock(states: Set<string>, text: string): boolean {
  for (const character of text) {
    const next = new Set<string>();
    for (const key of states) {
      const parts = key.split(",");
      const pre = Number(parts[0] ?? 0);
      const digit = Number(parts[1] ?? 0);
      const lock = Number(parts[2] ?? 0);
      const add = (prefix: number, seenDigit: number, lockPos: number) => {
        next.add(`${prefix},${seenDigit},${lockPos}`);
      };
      const expected = X_LOCK_SUFFIX[lock];
      if (lock > 0) {
        if (expected !== undefined && character === expected) add(pre, digit, lock + 1);
      } else if (pre === X_LOCK_PREFIX.length) {
        if (/\d/.test(character)) add(pre, 1, 0);
        else if (digit === 1 && character === "-") add(pre, 1, 1);
      } else if (character === X_LOCK_PREFIX[pre]) {
        add(pre + 1, 0, 0);
      }
      if (character === "/") add(1, 0, 0);
      else add(0, 0, 0);
    }
    if ([...next].some((key) => key.endsWith(`,${X_LOCK_SUFFIX.length}`))) return true;
    states.clear();
    for (const key of next) states.add(key);
  }
  return false;
}

/** `/tmp/.x<digits>-lock` assembled from the visible pieces. */
function spliceContainsXLock(
  segments: readonly string[],
  holes: readonly (readonly string[])[],
): boolean {
  let states = new Set<string>(["0,0,0"]);
  if (consumeXLock(states, segments[0] ?? "")) return true;
  for (let index = 0; index < holes.length; index += 1) {
    const start = new Set(states);
    const merged = new Set<string>();
    for (const insert of holes[index] ?? [""]) {
      const clone = new Set(start);
      if (consumeXLock(clone, insert)) return true;
      for (const state of clone) merged.add(state);
    }
    states = merged;
    if (consumeXLock(states, segments[index + 1] ?? "")) return true;
  }
  return false;
}

function basenamePossible(
  segments: readonly string[],
  holes: readonly (readonly string[])[],
  name: string,
): boolean {
  return spliceEquals(segments, holes, name) || scanSpliceTarget(segments, holes, `/${name}`).ends;
}

/**
 * The candidate list is capped. A dropped combination still counts when the
 * visible pieces can form a lifecycle word; a dash-joined command substitution
 * cannot, so ordinary script text stays allowed.
 */
function overflowLifecycle(piece: SplicePiece): {
  hazard: boolean;
  service: boolean;
  action: boolean;
} {
  const { segments, holes } = foldedSplice(piece);
  const none = { hazard: false, service: false, action: false };
  if (holes.length === 0) return none;
  for (const name of ["kill", "pkill", "killall", "xkill"]) {
    if (basenamePossible(segments, holes, name))
      return { hazard: true, service: false, action: false };
  }
  for (const snippet of [".browser-profiles", "--user-data-dir", "/tmp/.x11-unix"]) {
    if (scanSpliceTarget(segments, holes, snippet).contains) {
      return { hazard: true, service: false, action: false };
    }
  }
  if (spliceContainsXLock(segments, holes)) return { hazard: true, service: false, action: false };
  return {
    hazard: false,
    service: ["systemctl", "service"].some((name) => basenamePossible(segments, holes, name)),
    action: ["stop", "restart", "kill"].some((name) => basenamePossible(segments, holes, name)),
  };
}

function splicedLifecycleHazard(body: string): boolean {
  const pieces = splicePieces(body);
  if (!pieces) return false;
  const words: string[] = [];
  let serviceAffix = false;
  let overflowService = false;
  let overflowAction = false;
  for (const piece of pieces) {
    const produced = pieceCandidates(piece);
    words.push(...produced.words);
    if (produced.overflow) {
      const extra = overflowLifecycle(piece);
      if (extra.hazard) return true;
      if (extra.service) overflowService = true;
      if (extra.action) overflowAction = true;
    }
    const kind = spliceAffixKind(piece);
    if (kind === "solo") return true;
    if (kind === "service") serviceAffix = true;
  }
  if (wordsHaveLifecycleHazard(words)) return true;
  const sawAction =
    overflowAction ||
    words.some((word) =>
      /^(?:stop|restart|kill)$/.test((word.split("/").at(-1) ?? "").toLowerCase()),
    );
  return (serviceAffix || overflowService) && sawAction;
}
