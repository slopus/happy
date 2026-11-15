import { useLingui } from "@lingui/react/macro";
import { MarkdownLinkPromptProvider } from "@rakazo/chat-ui/web";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useTrustedLinkSites } from "../lib/trusted-link-sites";

export function MarkdownLinkPrompt({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const { sites, trust } = useTrustedLinkSites();
  // Stable while the locale is, so the chat below does not redraw with every app render.
  const copy = useMemo(
    () => ({
      title: t`Open external link?`,
      cancel: t`Cancel`,
      open: t`Open`,
      alwaysOpen: (site: string) => t`Always open ${site}`,
    }),
    [t],
  );
  return (
    <MarkdownLinkPromptProvider copy={copy} trustedSites={sites} trustSite={trust}>
      {children}
    </MarkdownLinkPromptProvider>
  );
}
