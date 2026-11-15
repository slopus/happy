import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../../lib/relative-time";
import { PageFrame } from "./PageFrame";
import { PageTileIcon } from "./page-icon";

/** Pages draw at desktop width and shrink into the card, so a preview reads like the page. */
// Large enough that the preview's body text stays readable, not grey texture.
const PREVIEW_SCALE = 0.75;
const PREVIEW_ASPECT = 630 / 1200;

/** The nearest ancestor that scrolls, so "near view" is measured along the chat, not the window. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
  }
  return null;
}

/** Previews kept running after they leave view, so scrolling back shows them drawn. */
const LIVE_PREVIEWS = 24;
const livePreviews = new Map<object, { near: boolean; drop: () => void }>();

/**
 * The page's top, drawn live at `width / PREVIEW_SCALE` and scaled down. It mounts once the card
 * scrolls near view and keeps running until newer previews push it out of the live set, so a
 * long chat runs a bounded number of pages.
 */
function PagePreview({
  document,
  title,
  failed,
}: {
  document: string | null;
  title: string;
  failed: boolean;
}) {
  const { t } = useLingui();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [live, setLive] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const onDrawn = useCallback(() => setDrawn(true), []);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) =>
      setSize({ width: entry?.contentRect.width ?? 0, height: entry?.contentRect.height ?? 0 }),
    );
    resize.observe(element);
    const key = {};
    const drop = () => {
      livePreviews.delete(key);
      setLive(false);
      setDrawn(false);
    };
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (!entry.isIntersecting) {
          const preview = livePreviews.get(key);
          if (preview) preview.near = false;
          return;
        }
        livePreviews.delete(key);
        livePreviews.set(key, { near: true, drop });
        setLive(true);
        let over = livePreviews.size - LIVE_PREVIEWS;
        for (const [other, preview] of livePreviews) {
          if (over <= 0) break;
          if (other === key || preview.near) continue;
          preview.drop();
          over--;
        }
      },
      { root: scrollParent(element), rootMargin: "400px 0px" },
    );
    near.observe(element);
    return () => {
      resize.disconnect();
      near.disconnect();
      livePreviews.delete(key);
    };
  }, []);
  return (
    <div
      ref={box}
      aria-hidden="true"
      // A touch tablet card shows at least 335px of page however narrow the chat makes it.
      className="pointer-events-none relative w-full overflow-hidden bg-card pointer-coarse:min-[900px]:min-h-[335px]"
      style={{ aspectRatio: `${1 / PREVIEW_ASPECT}` }}
    >
      {live && document !== null && size.width > 0 ? (
        <div
          inert
          // On a touch tablet the preview starts 13px further up the page.
          className="absolute top-0 left-0 origin-top-left pointer-coarse:min-[900px]:-top-[13px]"
          style={{
            width: size.width / PREVIEW_SCALE,
            // Taller than the box by that upward shift, so no blank strip shows below.
            height: (size.height + 13) / PREVIEW_SCALE,
            transform: `scale(${PREVIEW_SCALE})`,
          }}
        >
          <PageFrame document={document} title={title} onHeight={onDrawn} />
        </div>
      ) : null}
      {drawn ? null : (
        // The page's shape until it draws, so the card never sits empty; still once it can't load.
        <div
          className={`absolute inset-0 flex flex-col gap-3 bg-card px-6 pt-6 ${failed ? "" : "motion-safe:animate-pulse"}`}
        >
          <div className="h-5 w-2/5 rounded-[6px] bg-foreground/[0.06]" />
          <div className="h-3 w-3/5 rounded-[5px] bg-foreground/[0.05]" />
          <div className="mt-2 grid grid-cols-3 gap-2">
            <div className="h-12 rounded-sm bg-foreground/[0.05]" />
            <div className="h-12 rounded-sm bg-foreground/[0.05]" />
            <div className="h-12 rounded-sm bg-foreground/[0.05]" />
          </div>
          {failed ? (
            <p className="text-center text-muted-foreground text-body">{t`This page couldn't load`}</p>
          ) : null}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-[100px] bg-linear-to-b from-transparent to-card" />
    </div>
  );
}

/** A page in the chat: its live top and a footer naming it. The whole card opens the page. */
export function PageCard({
  title,
  document,
  onOpen,
  updated = false,
  updatedAt,
  shared = false,
  failed = false,
}: {
  title: string;
  /** When the page last changed, said under its title. */
  updatedAt?: string;
  /** Anyone with the link can open it. */
  shared?: boolean;
  document: string | null;
  /** The page could not be read, so its preview stops looking like it is loading. */
  failed?: boolean;
  /** Absent once the page is deleted: the card stays in the chat and opens nothing. */
  onOpen?: () => void;
  /** A newer version of this page appears further down the chat. */
  updated?: boolean;
}) {
  const { t } = useLingui();
  const when = updatedAt ? formatRelativeTime(updatedAt) : "";
  return (
    <div
      data-testid="page-card"
      data-deleted={onOpen === undefined || undefined}
      className="relative w-full max-w-[561px] overflow-hidden pointer-coarse:min-[900px]:max-w-[639px] rounded-[24px] bg-card ring-[0.5px] ring-border has-focus-visible:ring-2 has-focus-visible:ring-ring data-deleted:bg-transparent data-deleted:opacity-70"
    >
      {onOpen ? <PagePreview document={document} title={title} failed={failed} /> : null}
      <div className="flex h-[73px] items-center gap-[14px] border-t border-foreground/[0.04] px-5">
        <PageTileIcon />
        <div className="min-w-0">
          <div className="relative top-[1px] truncate text-body-lg leading-[21px] text-foreground">
            {title}
          </div>
          <div className="truncate text-body text-muted-foreground">
            {onOpen === undefined ? (
              <Trans>Page · Deleted</Trans>
            ) : updated ? (
              <Trans>Page · Updated below</Trans>
            ) : when ? (
              shared ? (
                <Trans>Page · Shared · {when}</Trans>
              ) : (
                <Trans>Page · {when}</Trans>
              )
            ) : (
              <Trans>Page</Trans>
            )}
          </div>
        </div>
      </div>
      {onOpen ? (
        <button
          type="button"
          aria-label={t`Open ${title}`}
          onClick={onOpen}
          className="absolute inset-0 rounded-[24px] outline-none"
        />
      ) : null}
    </div>
  );
}
