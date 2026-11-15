import { useLayoutEffect, useRef, useState } from "react";

/** Above one line (~28px); two lines clear this. */
const COMPOSER_SINGLE_LINE_MAX_PX = 36;
/** One-line `gap-x-3.5`, subtracted on each side of the text. */
const COMPOSER_ONE_LINE_GAP_PX = 14;
/** Narrower than the expand check so a draft at the edge cannot flip. */
const COMPOSER_COLLAPSE_SLACK_PX = 16;

type ComposerLayout = { barHeight: number; fieldX: number; fieldY: number };

/** Screen coordinates; the bar grows upward from its bottom edge. */
function readComposerLayout(
  bar: HTMLElement | null,
  field: HTMLElement | null,
): ComposerLayout | null {
  if (!bar || !field) return null;
  const fieldBox = field.getBoundingClientRect();
  return {
    barHeight: bar.getBoundingClientRect().height,
    fieldX: fieldBox.left,
    fieldY: fieldBox.top,
  };
}

/** Hides the scrollbar while measuring and leaves the height at 0. */
function measureTextareaHeight(textarea: HTMLTextAreaElement, width?: number) {
  const { style } = textarea;
  style.overflowY = "hidden";
  if (width !== undefined) style.width = `${width}px`;
  style.height = "0px";
  const height = textarea.scrollHeight;
  style.overflowY = "";
  style.width = "";
  return height;
}

export function spaceBetween(
  first: Pick<DOMRect, "left" | "right">,
  second: Pick<DOMRect, "left" | "right">,
) {
  return Math.max(first.left, second.left) - Math.min(first.right, second.right);
}

function syncMirror(textarea: HTMLTextAreaElement, mirror: HTMLElement | null) {
  if (!mirror) return;
  mirror.style.direction = getComputedStyle(textarea).direction;
  mirror.style.scrollbarGutter = textarea.scrollHeight > textarea.clientHeight ? "stable" : "";
  mirror.scrollTop = textarea.scrollTop;
}

export function useComposerLayout(draft: string, hasChips: boolean) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const composerActionsRef = useRef<HTMLDivElement>(null);
  const composerBarRef = useRef<HTMLDivElement>(null);
  const composerFieldRef = useRef<HTMLDivElement>(null);
  const composerLayoutRef = useRef<ComposerLayout | null>(null);
  const previousExpandedRef = useRef(false);
  const composerAnimationsRef = useRef<Animation[]>([]);
  const expanded = composerExpanded || hasChips;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    function syncHeight() {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const bar = composerBarRef.current;
      // A chip can switch the grid in this commit; keep the previous box as the animation start.
      if ((bar?.dataset.expanded === "true") === previousExpandedRef.current) {
        const layout = readComposerLayout(bar, composerFieldRef.current);
        if (layout) composerLayoutRef.current = layout;
      }
      const contentHeight = measureTextareaHeight(textarea);
      textarea.style.height = `${contentHeight}px`;
      syncMirror(textarea, mirrorRef.current);
      if (draft.length === 0) {
        setComposerExpanded(false);
        return;
      }
      if (contentHeight > COMPOSER_SINGLE_LINE_MAX_PX) {
        setComposerExpanded(true);
        return;
      }
      const attach = attachButtonRef.current;
      const actions = composerActionsRef.current;
      if (!attach || !actions) return;
      const besideControls =
        spaceBetween(attach.getBoundingClientRect(), actions.getBoundingClientRect()) -
        2 * COMPOSER_ONE_LINE_GAP_PX;
      const heightBeside = measureTextareaHeight(
        textarea,
        besideControls - COMPOSER_COLLAPSE_SLACK_PX,
      );
      textarea.style.height = `${contentHeight}px`;
      syncMirror(textarea, mirrorRef.current);
      if (heightBeside <= COMPOSER_SINGLE_LINE_MAX_PX) setComposerExpanded(false);
    }

    const scrolled = () => syncMirror(el, mirrorRef.current);
    el.addEventListener("scroll", scrolled);
    syncHeight();
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const width = textarea.getBoundingClientRect().width;
      if (width === lastWidth) return;
      lastWidth = width;
      syncHeight();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", scrolled);
    };
  }, [draft]);

  useLayoutEffect(() => {
    if (previousExpandedRef.current === expanded) return;
    previousExpandedRef.current = expanded;
    const bar = composerBarRef.current;
    const field = composerFieldRef.current;
    const textarea = textareaRef.current;
    const start = composerLayoutRef.current;
    if (!bar || !field || !textarea) return;
    textarea.style.height = `${measureTextareaHeight(textarea)}px`;
    syncMirror(textarea, mirrorRef.current);
    const resting = readComposerLayout(bar, field);
    // A send or a cleared draft snaps back; nothing is left to follow.
    if (
      !start ||
      textarea.value === "" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      if (resting) composerLayoutRef.current = resting;
      return;
    }
    if (!resting) return;
    composerLayoutRef.current = resting;
    // Grow from the fixed bottom edge so the controls stay put.
    const timing = { duration: 120, easing: "cubic-bezier(0.2, 0, 0, 1)" };
    composerAnimationsRef.current = [
      bar.animate(
        [
          { height: `${start.barHeight}px`, overflow: "hidden" },
          { height: `${resting.barHeight}px`, overflow: "hidden" },
        ],
        timing,
      ),
      field.animate(
        [
          {
            transform: `translate(${start.fieldX - resting.fieldX}px, ${start.fieldY - resting.fieldY}px)`,
          },
          { transform: "none" },
        ],
        timing,
      ),
    ];
    return () => {
      const animations = composerAnimationsRef.current;
      // A chip removed mid-transition must shrink from the box on screen, not the finished target.
      if (animations.some((animation) => animation.playState === "running")) {
        const onScreen = readComposerLayout(composerBarRef.current, composerFieldRef.current);
        if (onScreen) composerLayoutRef.current = onScreen;
      }
      for (const animation of animations) animation.cancel();
      composerAnimationsRef.current = [];
    };
  }, [expanded]);
  return {
    textareaRef,
    mirrorRef,
    attachButtonRef,
    composerActionsRef,
    composerBarRef,
    composerFieldRef,
    expanded,
  };
}
