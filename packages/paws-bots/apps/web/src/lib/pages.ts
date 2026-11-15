import { hostRoot, pawsFetch } from "../paws/runtime";
import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { PAGE_RUNTIME_PATH, pageReply, pageReplyText, pageViewerDocument } from "@rakazo/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useSpaceQueries } from "./query";
import { errorCode } from "./user-error";

/** The search parameter naming the page open full screen over a chat. */
export const PAGE_PARAM = "page";

function readTheme(): "light" | "dark" {
  return hostRoot().dataset.theme === "light" ? "light" : "dark";
}

function readSurface(on: "card" | "background"): string {
  return getComputedStyle(hostRoot()).getPropertyValue(`--${on}`).trim();
}

export function useMedia(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(hostRoot(), { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The app's light or dark theme, following changes. */
export function useAppTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeTheme, readTheme, () => "dark" as const);
}

async function fetchPageRuntime(): Promise<string> {
  const response = await pawsFetch(PAGE_RUNTIME_PATH);
  if (!response.ok) throw new Error(`Page runtime returned ${response.status}`);
  return response.text();
}

/**
 * A page's compiled code as the sandboxed viewer's document; null until the runtime has loaded.
 * `failed` says the runtime could not be fetched, and `retry` fetches it again.
 */
export function usePageDocument(
  code: string | undefined,
  /** The app surface behind the page; a tablet sheet sits on the background. */
  on: "card" | "background" = "card",
  /** The chat's composer is beside the page, so its reply buttons can fill it. */
  reply = false,
  /** Pixels a composer docked over the page's bottom covers. */
  bottomInset = 0,
): { document: string | null; failed: boolean; retry: () => void } {
  const { t, i18n } = useLingui();
  const theme = useAppTheme();
  // The surface follows the theme, so it is read again whenever the theme changes.
  const surface = useMemo(() => (theme ? readSurface(on) : ""), [theme, on]);
  const touch = useMedia("(pointer: coarse)");
  // Fetched again on every mount; the browser revalidates the server's no-cache runtime.
  const runtime = useQuery({ queryKey: ["page-runtime"], queryFn: fetchPageRuntime });
  const errorTitle = t`This page couldn't be shown.`;
  const viewerDocument = useMemo(
    () =>
      runtime.data === undefined || code === undefined
        ? null
        : pageViewerDocument({
            runtime: runtime.data,
            code,
            theme,
            errorTitle,
            surface,
            touch,
            reply,
            bottomInset,
            lang: i18n.locale,
          }),
    [runtime.data, code, theme, errorTitle, surface, touch, reply, bottomInset, i18n.locale],
  );
  const { refetch } = runtime;
  const retry = useCallback(() => void refetch(), [refetch]);
  return { document: viewerDocument, failed: runtime.isError && runtime.data === undefined, retry };
}

type Dock = { node: HTMLElement | null; page: { id: string; title: string } | null };

/**
 * One chat's open-page state: what opened the page (for focus), a Share asked for with it, and
 * where the composer docks. Shared by the shell, the open page and the composer through context.
 */
export function createPageSession() {
  let opener: { element: HTMLElement; ring: boolean } | null = null;
  let shareRequest: string | null = null;
  let dock: Dock = { node: null, page: null };
  const dockListeners = new Set<() => void>();
  const replyListeners = new Set<(text: string) => void>();
  return {
    rememberOpener() {
      const element = document.activeElement;
      opener =
        element instanceof HTMLElement
          ? { element, ring: element.matches(":focus-visible") }
          : null;
    },
    /** Focus goes back to what opened the page, with a ring only if it had one. */
    restoreFocus() {
      if (!opener?.element.isConnected) return true;
      opener.element.focus({ focusVisible: opener.ring } as FocusOptions);
      return false;
    },
    askShare(pageId: string | null) {
      shareRequest = pageId;
    },
    /** Share asked for with this page, taken once so history never pops it open again. */
    takeShare(pageId: string) {
      const asked = shareRequest === pageId;
      shareRequest = null;
      return asked;
    },
    dock: {
      set(next: Partial<Dock>) {
        const merged = { ...dock, ...next };
        if (
          merged.node === dock.node &&
          merged.page?.title === dock.page?.title &&
          merged.page?.id === dock.page?.id
        )
          return;
        dock = merged;
        for (const listener of dockListeners) listener();
      },
      subscribe(listener: () => void) {
        dockListeners.add(listener);
        return () => dockListeners.delete(listener);
      },
      get: () => dock,
    },
    /** A page's reply button hands its text to the chat's composer; the user still sends it. */
    offerReply(text: unknown) {
      const clean = pageReplyText(text);
      if (!clean || !dock.page) return;
      for (const listener of replyListeners) listener(clean);
    },
    subscribeReply(listener: (text: string) => void) {
      replyListeners.add(listener);
      return () => {
        replyListeners.delete(listener);
      };
    },
    /** From the open page: reply to its card, or name the page if this chat has none. */
    send(
      text: string,
      messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
      chosenReplyId?: string,
    ): { text: string; replyToMessageId?: string } {
      return pageReply(text, messages, dock.page, chosenReplyId);
    },
  };
}
export type PageSession = ReturnType<typeof createPageSession>;

type OpenPage = (pageId: string, options?: { share?: boolean }) => void;
type Pages = { open: OpenPage; session: PageSession };

const PagesContext = createContext<Pages | null>(null);

/** The chat's pages; outside a chat nothing opens. */
export const PagesProvider = PagesContext.Provider;

export function useOpenPage(): OpenPage {
  return useContext(PagesContext)?.open ?? noop;
}
const noop: OpenPage = () => {};

export function usePageSession(): PageSession | null {
  return useContext(PagesContext)?.session ?? null;
}

/** Opens a page by URL, remembering what opened it so focus can go back there. */
export function usePagesForChat(): Pages {
  const [session] = useState(createPageSession);
  const [, setSearchParams] = useSearchParams();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const open = useCallback<OpenPage>(
    (pageId, options) => {
      // A page known to be deleted (its card says so) opens nothing, from a card or a link chip.
      const known = queryClient.getQueryState(queries.pages.get.queryKey({ input: { pageId } }));
      if (errorCode(known?.error) === "NOT_FOUND") return;
      session.rememberOpener();
      session.askShare(options?.share ? pageId : null);
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set(PAGE_PARAM, pageId);
        return next;
      });
    },
    [session, setSearchParams, queries, queryClient],
  );
  return useMemo(() => ({ open, session }), [open, session]);
}
