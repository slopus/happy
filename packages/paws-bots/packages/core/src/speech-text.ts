import type { MessageBlock } from "@rakazo/contracts";

/** A fenced block becomes a mention of itself, with its language if known. */
function describeCodeBlock(fence: string): string {
  const lang =
    fence
      .trim()
      .split(/\s+/)[0]
      ?.replace(/[^a-z0-9+#]/gi, "") ?? "";
  const spoken: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    json: "JSON",
    yml: "YAML",
    yaml: "YAML",
    sql: "SQL",
    rs: "Rust",
    go: "Go",
    swift: "Swift",
    diff: "diff",
  };
  const name = spoken[lang.toLowerCase()];
  return name ? `. (a ${name} code block) ` : ". (a code block) ";
}

/** `a/b/c/file.ts` → `file.ts`. A path's directories are for the eye. */
function shortenPaths(text: string): string {
  return text.replace(/(?:[\w.@-]+\/){1,}([\w.-]+\.\w{1,6})\b/g, "$1");
}

const ENDS_SENTENCE = /[.!?:;]\s*$/;

const WORD_CHAR = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;
const LINE_END = /[\n\r\u2028\u2029]/;

/**
 * `*word*` and `_word_` → `word`, leaving `snake_case` and `2*3` alone.
 *
 * A marker opens when it follows no letter or digit and precedes a non-space;
 * it closes at the nearest same marker on that line that follows a non-space
 * and precedes no letter or digit. A regex with those lookarounds rescans the
 * rest of the line for every unclosed opener, so this precomputes the nearest
 * closer instead and stays linear in the input.
 */
function stripSingleEmphasis(text: string): string {
  const chars = Array.from(text);
  const n = chars.length;
  const isWordChar = (k: number) => k >= 0 && k < n && WORD_CHAR.test(chars[k] ?? "");
  const nextCloser: Record<string, Int32Array> = {
    "*": new Int32Array(n + 1).fill(-1),
    _: new Int32Array(n + 1).fill(-1),
  };
  for (let k = n - 1; k >= 0; k--) {
    const char = chars[k] ?? "";
    for (const [marker, next] of Object.entries(nextCloser)) {
      if (LINE_END.test(char)) next[k] = -1;
      else if (char === marker && k > 0 && !SPACE.test(chars[k - 1] ?? " ") && !isWordChar(k + 1))
        next[k] = k;
      else next[k] = next[k + 1] ?? -1;
    }
  }

  let out = "";
  let i = 0;
  while (i < n) {
    const char = chars[i] ?? "";
    const next = nextCloser[char];
    if (next && !isWordChar(i - 1) && i + 1 < n && !SPACE.test(chars[i + 1] ?? " ")) {
      const close = next[i + 1] ?? -1;
      if (close !== -1) {
        out += chars.slice(i + 1, close).join("");
        i = close + 1;
        continue;
      }
    }
    out += char;
    i++;
  }
  return out;
}

/**
 * Markdown (or any agent output) → a line a voice can read.
 *
 * Say the prose, name the artifacts, drop the syntax. Pure and synchronous
 * so it stays easy to tune against real transcripts.
 */
export function speakable(input: string): string {
  if (!input) return "";
  let text = input;

  text = text.replace(/```([^\n]*)\n[\s\S]*?(?:```|$)/g, (_m, fence: string) =>
    describeCodeBlock(fence),
  );
  text = text.replace(/~~~([^\n]*)\n[\s\S]*?(?:~~~|$)/g, (_m, fence: string) =>
    describeCodeBlock(fence),
  );

  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) =>
    alt ? `. (image: ${alt}) ` : ". (an image) ",
  );
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<https?:\/\/[^>\s]+>/g, " a link ");
  text = text.replace(/\bhttps?:\/\/\S+/g, " a link ");

  text = text.replace(/^\s*\|?[\s:-]*\|[\s|:-]*$/gm, "");
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_m, row: string) =>
    row
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(", "),
  );

  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    code.length <= 40 ? code : " that snippet ",
  );

  text = text.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, (_m, head: string) =>
    ENDS_SENTENCE.test(head) ? head : `${head.trim()}.`,
  );

  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");

  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = stripSingleEmphasis(text);
  text = text.replace(/~~(.*?)~~/g, "$1");

  text = text.replace(/\[[ xX]\]\s*/g, "");

  text = shortenPaths(text);

  text = text.replace(
    /[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
    "",
  );

  text = text.replace(/\n{2,}/g, ". ");
  text = text.replace(/\n/g, ". ");

  text = text.replace(/\s+/g, " ");
  text = text.replace(/\s+([.,!?;:])/g, "$1");
  text = text.replace(/(?:\.\s*){2,}/g, ". ");
  text = text.replace(/,\s*\./g, ".");
  text = text.trim();

  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

const BOUNDARY =
  /(?<!\b(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|No|approx))(?<![.\d])([.!?])(["')\]]*)\s+/g;

/**
 * Split speakable text into utterances a synthesizer can start on.
 * Short fragments are glued onto their neighbour so the voice keeps context.
 * maxChars bounds UTF-16 code units, matching the synthesis API's limit.
 */
export function toUtterances(input: string, { minChars = 12, maxChars = 320 } = {}): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 2) {
    throw new RangeError("maxChars must be an integer of at least 2");
  }
  const text = speakable(input);
  if (!text) return [];

  const MARK = "\u0000";
  const rough = text
    .replace(BOUNDARY, `$1$2${MARK}`)
    .split(MARK)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const piece of rough) {
    const parts = piece.length <= maxChars ? [piece] : splitLong(piece, maxChars);
    for (const [index, part] of parts.entries()) {
      const prev = out[out.length - 1];
      if (
        index === 0 &&
        prev &&
        (prev.length < minChars || part.length < minChars) &&
        prev.length + 1 + part.length <= maxChars
      ) {
        out[out.length - 1] = `${prev} ${part}`;
      } else {
        out.push(part);
      }
    }
  }
  return out;
}

function splitLong(text: string, maxChars: number): string[] {
  const out: string[] = [];
  const segmenter =
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : undefined;
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const at = Math.max(
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
      window.lastIndexOf(" — "),
    );
    let cut = at > maxChars / 2 ? at + 1 : window.lastIndexOf(" ");
    if (cut <= 0) {
      cut = 0;
      if (segmenter) {
        for (const { index, segment } of segmenter.segment(rest)) {
          const end = index + segment.length;
          if (end > maxChars) break;
          cut = end;
        }
      }
      // A single grapheme may exceed the budget; older native runtimes may
      // also lack Segmenter. Still make progress without splitting a surrogate pair.
      if (cut === 0) {
        cut = maxChars;
        const last = rest.charCodeAt(cut - 1);
        if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
      }
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A tool-activity chip as a spoken progress line. Null when it is not worth hearing. */
export function narrateTool(toolName: string): string | null {
  const name = toolName.replace(/^mcp__[^_]+__/, "").trim();
  if (!name) return null;
  if (/^(auto-approved|error):/i.test(name)) return null;

  const bare = name.toLowerCase();
  const verbs: Array<[RegExp, string]> = [
    [/^(bash|shell|terminal|run_command|execute|computer_exec)$/, "running a command"],
    [/^(read|read_file|view|list_files)$/, "reading a file"],
    [/^(write|write_file|create_file)$/, "writing a file"],
    [/^(edit|apply_patch|str_replace|multiedit)$/, "editing a file"],
    [/^(grep|search|glob|find)$/, "searching"],
    [/^(web_?search|websearch)$/, "searching the web"],
    [/^(web_?fetch|fetch)$/, "reading a page"],
    [/^(screenshot|computer_observe)$/, "looking at the screen"],
    [/^(browser_navigate|browser_snapshot|browser_act)$/, "using the page"],
    [/^(click|type_text|press_key|scroll|computer_batch|computer_act)$/, "using the computer"],
    [/^open_url$/, "opening a page"],
    [/^list_bots$/, "checking who's around"],
    [/^ask_bot$/, "asking a teammate"],
    [/^run_subagent$/, "starting a subagent"],
    [/^spawn_bot$/, "creating a bot"],
    [/^create_space$/, "creating a space"],
    [/^list_fleet$/, "checking your bots"],
    [/^create_group$/, "creating a group"],
    [/^update_group$/, "updating a group"],
    [/^organize_bot$/, "organizing the sidebar"],
    [/^set_child_instructions$/, "rewriting a bot's instructions"],
    [/^set_child_bot_model$/, "setting a bot's model"],
    [/^create_child_routine$/, "scheduling a routine"],
    [/^archive_bot$/, "archiving a bot"],
    [/^remember$/, "writing a memory"],
    [/^save_shared_memory$/, "saving shared memory"],
    [/^attach_file$/, "attaching a file"],
    [/^request_takeover$/, "asking you to take over"],
  ];
  for (const [pattern, phrase] of verbs) {
    if (pattern.test(bare)) return phrase;
  }
  const short = shortenPaths(name).slice(0, 40);
  return /^[\w .:/-]+$/.test(short) ? `running ${short}` : null;
}

export function speechFromBlocks(blocks: MessageBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "text" || block.kind === "progress" || block.kind === "meta")
        return block.text;
      if (block.kind === "ask") return block.text;
      if (block.kind === "cloud_agent")
        return `${block.title}: ${block.status}${block.prUrl ? ` ${block.prUrl}` : ""}`;
      if (block.kind === "computer") return block.text;
      if (block.kind === "subagent") {
        if (block.status === "running") return `${block.name} is working on ${block.task}`;
        if (block.status === "failed") return `${block.name} failed`;
        return block.result || `${block.name} finished`;
      }
      if (block.kind === "card") {
        return block.lines.map((line) => `${line.k}: ${line.v}`).join(". ");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// Without its accent "si" is Spanish for "if", so only "sí" says yes. `\b` only knows
// ASCII letters, so a word ends wherever no letter or digit follows.
const YES_WORDS =
  "yes|yeah|yep|yup|ok|okay|sure|do it|go ahead|approve|confirmed|affirmative|sí|vale|okey|de acuerdo|adelante|hazlo|confirmo|aprobado";
const NO_WORDS =
  "no|nope|nah|cancel|stop|don't|do not|reject|deny|negative|cancela|cancelar|cancélalo|rechaza|rechazado|mejor no|detente";
const WORD_END = "(?![\\p{L}\\p{N}])";
const YES = new RegExp(`^¡?(${YES_WORDS})${WORD_END}`, "iu");
const NO = new RegExp(`^¡?(${NO_WORDS})${WORD_END}`, "iu");
const NO_ANYWHERE = new RegExp(`(?<![\\p{L}\\p{N}])(${NO_WORDS})${WORD_END}`, "iu");

/** Consent must never be inferred from a sentence that merely contained "sure". */
export function spokenDecision(transcript: string): "yes" | "no" | null {
  const text = transcript.trim().replace(/[\u2018\u2019]/g, "'");
  // A question ("¿Sí? ¿Cuáles?") is not an answer.
  if (!text || /[?¿]/.test(text) || text.split(/\s+/).length > 6) return null;
  // "okay, do not" opens with a yes and means no. Only a yes can be wrong in a way that acts, so
  // a yes that also says no is no answer; a no that says "do it" ("don't do it") stays a no.
  if (YES.test(text)) return NO_ANYWHERE.test(text) ? null : "yes";
  if (NO.test(text)) return "no";
  return null;
}
