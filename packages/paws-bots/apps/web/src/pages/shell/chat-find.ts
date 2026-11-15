const MESSAGE = "[data-message-id]";
const BLOCK = "p,li,div,pre,h1,h2,h3,h4,h5,h6,td,th,blockquote";

/**
 * Lowercase for matching, the same on every device rather than by the system's language
 * (which would turn I into ı for some). Greek sigma lowercases to a final form at the end of a word, which
 * a character-by-character fold never sees, so both forms fold to the same letter.
 */
function fold(text: string) {
  return text.toLowerCase().replaceAll("ς", "σ");
}

const SPACE = /\s/;
const SEPARATORS = new Set(["BR", "IMG", "svg", "VIDEO"]);

/** One code unit of a message's lowercased text and the source character it came from. */
type Unit = { node: Text; start: number; end: number } | null;

function searchable(node: Text) {
  const parent = node.parentElement;
  if (!parent || parent.closest("button, [aria-hidden='true']")) return false;
  // A collapsed tool step or other hidden text would be a match the user cannot see.
  return typeof parent.checkVisibility === "function" ? parent.checkVisibility() : true;
}

/**
 * Lowercases a message's visible text one character at a time, remembering where each
 * resulting code unit came from, so a match maps back to the DOM even when lowercasing
 * changes a character's length or the match crosses a link or bold text. Any run of whitespace
 * counts as one space, in messages and queries alike, since prose collapses it on screen while
 * sent messages and code keep it.
 */
function messageText(message: Element) {
  const walker = message.ownerDocument.createTreeWalker(
    message,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  let text = "";
  const units: Unit[] = [];
  let block: Element | null = null;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      // A line break or an image separates the words either side of it.
      if (SEPARATORS.has((current as Element).tagName)) {
        text += "\n";
        units.push(null);
      }
      continue;
    }
    const node = current as Text;
    if (!searchable(node)) {
      // Skipped text (a page chip, a hidden step) still sits between its neighbours.
      if (units.at(-1) !== null) {
        text += "\n";
        units.push(null);
      }
      continue;
    }
    const nodeBlock = node.parentElement?.closest(BLOCK) ?? null;
    // Separate paragraphs, so the end of one and the start of the next never form a match.
    if (block && nodeBlock !== block) {
      text += "\n";
      units.push(null);
    }
    block = nodeBlock;
    const value = node.nodeValue ?? "";
    for (let at = 0; at < value.length; ) {
      const char = String.fromCodePoint(value.codePointAt(at) ?? 0);
      if (SPACE.test(char)) {
        if (!SPACE.test(text.at(-1) ?? "")) {
          text += " ";
          units.push({ node, start: at, end: at + char.length });
        }
        at += char.length;
        continue;
      }
      const lower = fold(char);
      for (let unit = 0; unit < lower.length; unit++) {
        units.push({ node, start: at, end: at + char.length });
      }
      text += lower;
      at += char.length;
    }
  }
  return { text, units };
}

/** Every case-insensitive match of `query` in the chat messages under `root`, in document order. */
export function findTextRanges(root: ParentNode, query: string): Range[] {
  const needle = fold(query).replace(/\s+/g, " ");
  if (!needle.trim()) return [];
  const ranges: Range[] = [];
  for (const message of root.querySelectorAll(MESSAGE)) {
    const { text, units } = messageText(message);
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const first = units[at];
      const last = units[at + needle.length - 1];
      if (!first || !last) continue;
      const range = message.ownerDocument.createRange();
      range.setStart(first.node, first.start);
      range.setEnd(last.node, last.end);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Whether two ranges start at the same place, so a selection survives a fresh search. */
export function sameStart(a: Range, b: Range) {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset;
}
