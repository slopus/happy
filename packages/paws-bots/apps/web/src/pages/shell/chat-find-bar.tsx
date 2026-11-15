import { useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useState } from "react";
import { findTextRanges, sameStart } from "./chat-find";

const MATCHES = "rk-find";
const CURRENT = "rk-find-current";
const REFRESH_MS = 250;

/**
 * Centers the match itself in each scrolling box from the innermost out to the transcript, since
 * it may sit deep in a tall or wide code block or a capped detail that scrolls on its own.
 */
function reveal(range: Range) {
  const scroller = range.startContainer.parentElement?.closest('[data-testid="transcript"]');
  if (!scroller) return;
  for (let box = range.startContainer.parentElement; box; box = box.parentElement) {
    const match = range.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    if (box.scrollWidth > box.clientWidth && (match.left < view.left || match.right > view.right)) {
      box.scrollLeft += match.left - view.left - (view.width - match.width) / 2;
    }
    if (box === scroller || box.scrollHeight > box.clientHeight) {
      box.scrollTop += match.top - view.top - (view.height - match.height) / 2;
    }
    if (box === scroller) break;
  }
}

function setHighlights(all: Range[], current: Range | undefined) {
  // Painting needs the CSS Custom Highlight API; without it Enter still scrolls to each match.
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") {
    return;
  }
  // One range at a time: a short query in a long chat can match more ranges than a call takes.
  const matches = new Highlight();
  for (const range of all) matches.add(range);
  CSS.highlights.set(MATCHES, matches);
  if (current) CSS.highlights.set(CURRENT, new Highlight(current));
  else CSS.highlights.delete(CURRENT);
}

function clearHighlights() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.delete(MATCHES);
  CSS.highlights.delete(CURRENT);
}

/** Finds text in the open chat's loaded messages, the desktop app's Cmd/Ctrl+F. */
export function ChatFindBar({
  scope,
  inputRef,
  onClose,
}: {
  /** The chat column. The transcript inside it remounts when a chat's history loads. */
  scope: RefObject<HTMLElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ ranges: Range[]; index: number }>({ ranges: [], index: 0 });
  const { ranges } = found;

  // Streaming replies and older history change the transcript while the bar is open. A new
  // query jumps to its first match; a refresh keeps the selected match where it is.
  useEffect(() => {
    const transcript = scope.current;
    if (!transcript) {
      setFound({ ranges: [], index: 0 });
      return;
    }
    const first = findTextRanges(transcript, query);
    setFound({ ranges: first, index: 0 });
    if (first[0]) reveal(first[0]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      timer = undefined;
      const next = findTextRanges(transcript, query);
      setFound((previous) => {
        const selected = previous.ranges[previous.index];
        const kept = selected ? next.findIndex((range) => sameStart(range, selected)) : -1;
        return {
          ranges: next,
          index: kept === -1 ? Math.min(previous.index, next.length - 1) : kept,
        };
      });
    };
    // A streaming reply changes the transcript many times a second; rescanning a few times a
    // second keeps the count current without searching on every token.
    // The bar sits in the column it watches; its own count changing is not a change to the chat.
    const observer = new MutationObserver((records) => {
      const chatChanged = records.some((record) => {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        return !target?.closest('[data-testid="chat-find"]');
      });
      if (chatChanged) timer ??= setTimeout(refresh, REFRESH_MS);
    });
    observer.observe(transcript, {
      childList: true,
      subtree: true,
      characterData: true,
      // Opening or closing a disclosure (a tool step) changes which text is visible.
      attributeFilter: ["hidden", "open", "aria-expanded", "data-open", "data-closed"],
    });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [query, scope]);

  const current = ranges.length > 0 ? Math.max(0, Math.min(found.index, ranges.length - 1)) : -1;
  const currentRange = current === -1 ? undefined : ranges[current];

  useLayoutEffect(() => setHighlights(ranges, currentRange), [ranges, currentRange]);
  useEffect(() => clearHighlights, []);

  function step(by: 1 | -1) {
    if (ranges.length === 0) return;
    const index = (current + by + ranges.length) % ranges.length;
    setFound({ ranges, index });
    const range = ranges[index];
    if (range) reveal(range);
  }

  return (
    <search
      className="flex items-center gap-1 rounded-xl border border-border bg-popover p-1 shadow-md"
      data-testid="chat-find"
      onKeyDown={(event) => {
        // Escape first cancels a half-typed IME word; only a plain Escape closes the bar.
        if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) {
          return;
        }
        event.preventDefault();
        onClose();
      }}
    >
      <Input
        ref={inputRef}
        type="search"
        aria-label={t`Find in chat`}
        placeholder={t`Find in chat`}
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }}
        className="h-8 w-56 border-0 bg-transparent shadow-none focus-visible:ring-0"
      />
      {query.trim() ? (
        <span
          className="shrink-0 px-1 text-label tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {current + 1}/{ranges.length}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t`Previous match`}
        disabled={ranges.length === 0}
        onClick={() => step(-1)}
      >
        <ChevronUp size={16} strokeWidth={1.8} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t`Next match`}
        disabled={ranges.length === 0}
        onClick={() => step(1)}
      >
        <ChevronDown size={16} strokeWidth={1.8} />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={t`Close`} onClick={onClose}>
        <X size={16} strokeWidth={1.8} />
      </Button>
    </search>
  );
}
