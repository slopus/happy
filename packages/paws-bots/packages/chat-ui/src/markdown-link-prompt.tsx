import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

type MarkdownLinkCopy = {
  title: string;
  cancel: string;
  open: string;
  alwaysOpen: (site: string) => string;
};

const defaultMarkdownLinkCopy: MarkdownLinkCopy = {
  title: "Open external link?",
  cancel: "Cancel",
  open: "Open",
  alwaysOpen: (site) => `Always open ${site}`,
};

type MarkdownLinkTrust = {
  /** Sites the reader opens without the prompt. */
  sites: readonly string[];
  /** Saves a link's site as trusted; null where the app cannot. A failed save is ignored. */
  trust: ((url: string) => void) | null;
};

const CopyContext = createContext<MarkdownLinkCopy>(defaultMarkdownLinkCopy);
const OriginContext = createContext<string | null>(null);
const TrustContext = createContext<MarkdownLinkTrust>({ sites: [], trust: null });

export function MarkdownLinkPromptProvider({
  copy = defaultMarkdownLinkCopy,
  appOrigin = null,
  trustedSites = [],
  trustSite,
  children,
}: {
  copy?: MarkdownLinkCopy;
  appOrigin?: string | null;
  trustedSites?: readonly string[];
  /** Saves the site of a link the reader chose to always open. */
  trustSite?: (url: string) => unknown;
  children: ReactNode;
}) {
  const trust = useMemo<MarkdownLinkTrust>(
    () => ({
      sites: trustedSites,
      trust: trustSite
        ? (url) => {
            // The link opens either way; a site that failed to save asks again next time.
            void Promise.resolve()
              .then(() => trustSite(url))
              .catch(() => undefined);
          }
        : null,
    }),
    [trustedSites, trustSite],
  );
  return (
    <CopyContext.Provider value={copy}>
      <OriginContext.Provider value={appOrigin}>
        <TrustContext.Provider value={trust}>{children}</TrustContext.Provider>
      </OriginContext.Provider>
    </CopyContext.Provider>
  );
}

export function useMarkdownLinkCopy() {
  return useContext(CopyContext);
}

export function useMarkdownLinkAppOrigin() {
  return useContext(OriginContext);
}

export function useMarkdownLinkTrust() {
  return useContext(TrustContext);
}
