import { useLingui } from "@lingui/react/macro";
import { PageIcon } from "@rakazo/chat-ui/web";
import { PAGE_TITLE_MAX_LENGTH } from "@rakazo/contracts";
import { cn, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { Pencil, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DARWIN_WINDOW_CONTROLS_WIDTH_PX,
  desktopBridge,
  windowChromeKind,
} from "../../lib/desktop";
import { DownloadPdfButton } from "./DownloadPdfButton";
import { PageFrame } from "./PageFrame";
import { PageLoading, PageNotice } from "./PageNotice";

/** How long a page may take to draw before the view offers to load it again. */
const FRAME_TIMEOUT_MS = 15_000;

/**
 * A page full screen: close at the top left, the title pill in the middle (click to rename),
 * Download PDF and sharing at the top right, and the bot's composer docked over the bottom of the
 * page. Printed, only the page shows, at its full height.
 */
export function PageView({
  open,
  onOpenChange,
  title,
  document,
  onRename,
  renameError = null,
  share,
  composer,
  onReply,
  returnFocus,
  compact = false,
  notice = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  document: string | null;
  /** Absent while a rename is being saved. */
  onRename?: (title: string) => void;
  renameError?: string | null;
  share: ReactNode;
  composer?: ReactNode;
  /** Takes a page's reply text into the docked composer. */
  onReply?: (text: unknown) => void;
  /** Puts focus back on close; false tells the dialog it is done. */
  returnFocus?: () => boolean;
  /** Touch screens get larger round controls. */
  compact?: boolean;
  /** Said in place of the page when it could not be opened. */
  notice?: ReactNode;
}) {
  const { t } = useLingui();
  const closeButton = useRef<HTMLButtonElement>(null);
  // The frame stays hidden until the page inside reports it has drawn, so neither a blank
  // frame nor a browser error page shows; a page that never draws gets a way to try again.
  const [drawn, setDrawn] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // A new document (an update, a theme change) has to draw again before it shows.
  const [shown, setShown] = useState(document);
  if (shown !== document) {
    setShown(document);
    setDrawn(false);
    setStalled(false);
  }
  const waiting = document !== null && !drawn && notice === null;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setStalled(true), FRAME_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, attempt]);
  const onDrawn = useCallback(() => setDrawn(true), []);
  // In the macOS app the window controls sit in the top-left corner over a full-window page, so
  // its top row starts below them, as the main window's rows do.
  const macChrome = !compact && windowChromeKind(desktopBridge()) === "darwin";
  const control = `grid place-items-center rounded-full p-0 border border-foreground/[0.06] text-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring ${compact ? "size-11" : "size-[35px]"}`;
  // The browser close control sits 11px in. On macOS that inset starts after the traffic-light
  // strip. The sum is a style because Tailwind only emits `left-[…]` from a complete literal.
  const closeLeadingInsetPx = 11;
  const closeButtonClass = cn(
    "app-no-drag absolute z-10 grid place-items-center rounded-full border border-foreground/[0.06] text-foreground/90 outline-none print:hidden hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring",
    compact ? "top-[6px] left-[6px] size-11" : "size-9",
    !compact && (macChrome ? "top-[42px]" : "top-[6px]"),
  );
  const closeButtonStyle = compact
    ? undefined
    : {
        left: macChrome
          ? DARWIN_WINDOW_CONTROLS_WIDTH_PX + closeLeadingInsetPx
          : closeLeadingInsetPx,
      };
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        // Escape in the share popover or its menu closes only that, not the page under it.
        // The popup may already be closing when this runs, so where the key landed decides.
        const target = details.event?.target;
        if (
          !next &&
          details.reason === "escape-key" &&
          target instanceof Element &&
          target.closest('[data-slot="popover-content"], [data-slot="dropdown-menu-content"]')
        ) {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Full screen, the page covers the chat whole: dimming it underneath would only flash
        // darker as the page fades in and out. The tablet sheet keeps it over the chat's edges.
        overlayClassName={
          compact ? undefined : "bg-transparent supports-backdrop-filter:backdrop-blur-none"
        }
        initialFocus={closeButton}
        finalFocus={returnFocus}
        data-testid="page-view"
        data-page-print
        className={`app-no-drag print:static print:h-auto print:overflow-visible print:bg-transparent print:animate-none top-0 left-0 block h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none bg-card p-0 ring-0 sm:max-w-none ease-[cubic-bezier(0.16,1,0.3,1)] data-open:duration-[260ms] data-open:zoom-in-[0.98] data-open:slide-in-from-bottom-3 data-closed:duration-150 data-closed:zoom-out-100 data-closed:fill-mode-forwards motion-reduce:data-open:zoom-in-100 motion-reduce:data-open:slide-in-from-bottom-0 ${
          compact ? "min-[900px]:bg-transparent" : ""
        }`}
      >
        {/* On a tablet the page is a sheet over the chat, covering all but the chat's edges. */}
        <div
          className={`absolute inset-0 overflow-hidden print:static print:overflow-visible print:bg-transparent ${
            compact
              ? "min-[900px]:inset-x-[70px] min-[900px]:bottom-[33px] min-[900px]:rounded-[28px] min-[900px]:bg-background"
              : ""
          }`}
        >
          {/* The desktop app's window drags by the strip above the page, as by the chat's header.
              The page itself is no-drag, so the drag areas of the window under it don't take its
              clicks: Electron honors them through anything drawn on top. */}
          <div
            aria-hidden="true"
            className={`app-drag absolute inset-x-0 top-0 print:hidden ${compact ? "h-[50px]" : macChrome ? "h-[70px]" : "h-[34px]"}`}
          />
          <DialogClose
            ref={closeButton}
            aria-label={t`Close page`}
            className={closeButtonClass}
            style={closeButtonStyle}
          >
            <X className={compact ? "size-6" : "size-[18px]"} strokeWidth={compact ? 2.2 : 1.7} />
          </DialogClose>
          <div
            className={`pointer-events-none absolute inset-x-0 z-10 flex justify-center print:hidden ${compact ? "top-[6px] px-[106px]" : `${macChrome ? "top-[38px]" : "top-[2px]"} px-[140px]`}`}
          >
            <div className="flex min-w-0 flex-col items-center gap-1">
              {title ? (
                <TitlePill title={title} onRename={onRename} />
              ) : (
                <DialogTitle className="sr-only">{t`Page`}</DialogTitle>
              )}
              {renameError ? (
                <p role="alert" className="text-label text-destructive">
                  {renameError}
                </p>
              ) : null}
            </div>
          </div>
          {/* Touch controls sit 6px in from the sheet's 28px corners: 22px round plus 6 is 28. */}
          <div
            className={`app-no-drag absolute z-10 flex items-center gap-1.5 print:hidden ${compact ? "top-[6px] right-[6px]" : `${macChrome ? "top-[42.5px]" : "top-[6.5px]"} right-3`}`}
          >
            {drawn && !stalled && notice === null ? (
              <DownloadPdfButton
                className={control}
                iconClassName={compact ? "size-5" : "size-[18px]"}
                labelClassName="sr-only"
              />
            ) : null}
            {share}
          </div>
          {/* After the controls, so Tab reaches Close, Download PDF and Share before the page's stops. */}
          <section
            aria-label={title || undefined}
            className={`absolute inset-x-0 bottom-0 print:static ${compact ? "top-[50px]" : macChrome ? "top-[70px]" : "top-[34px]"}`}
          >
            {notice ?? (
              <>
                {document !== null && !stalled ? (
                  <div
                    key={attempt}
                    className={`h-full transition-opacity duration-200 motion-reduce:transition-none ${drawn ? "opacity-100" : "opacity-0"}`}
                  >
                    <PageFrame
                      document={document}
                      title={title}
                      interactive
                      onReply={onReply}
                      onHeight={onDrawn}
                    />
                  </div>
                ) : null}
                {stalled ? (
                  <PageNotice
                    title={t`This page couldn't load`}
                    detail={t`Check your connection and try again.`}
                    onRetry={() => {
                      setStalled(false);
                      setAttempt((count) => count + 1);
                    }}
                    onClose={() => onOpenChange(false)}
                  />
                ) : !drawn ? (
                  <PageLoading />
                ) : null}
              </>
            )}
          </section>
        </div>
        {composer ? (
          <div className="absolute inset-x-0 bottom-[12.5px] flex justify-center px-3 print:hidden">
            <div className="w-full max-w-[551px]">{composer}</div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TitlePill({ title, onRename }: { title: string; onRename?: (title: string) => void }) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pill =
    "app-no-drag pointer-events-auto flex h-11 max-w-full min-w-0 items-center gap-3 rounded-full ring-[0.5px] ring-foreground/[0.06] pr-[15px] pl-[11px] text-body font-medium text-foreground";

  function commit() {
    const next = draft?.trim() ?? "";
    setDraft(null);
    if (next !== "" && next !== title) onRename?.(next);
  }

  if (draft !== null) {
    return (
      <div className={`${pill} bg-card ring-1 ring-ring`}>
        <PageIcon className="h-5 w-4 shrink-0" />
        <input
          ref={input}
          // biome-ignore lint/a11y/noAutofocus: the field appears because the title was clicked.
          autoFocus
          aria-label={t`Page title`}
          value={draft}
          maxLength={PAGE_TITLE_MAX_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              if (event.key === "Escape") event.stopPropagation();
              return;
            }
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              event.stopPropagation();
              setDraft(null);
            }
          }}
          className="w-[min(60vw,420px)] min-w-0 bg-transparent outline-none"
        />
      </div>
    );
  }
  return (
    <DialogTitle
      render={
        <button
          type="button"
          disabled={!onRename}
          onClick={() => setDraft(title)}
          title={onRename ? t`Rename` : undefined}
          className={`group/title ${pill} bg-card outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent`}
        />
      }
    >
      <PageIcon className="h-5 w-4 shrink-0" />
      <span className="truncate">{title}</span>
      {onRename ? (
        <Pencil
          aria-hidden="true"
          className="-mr-1 size-3.5 shrink-0 text-foreground/50 opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100 pointer-coarse:opacity-100"
          strokeWidth={1.8}
        />
      ) : null}
    </DialogTitle>
  );
}
