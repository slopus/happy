import { hostViewerUrl, listenWindow } from "../paws/runtime";
import { useLingui } from "@lingui/react/macro";
import { useExternalLinkOpener } from "@rakazo/chat-ui/web";
import type { MessageBlock } from "@rakazo/contracts";
import { MCP_APP_VIEWER_PATH } from "@rakazo/contracts/content-security-policy";
import { createMcpAppHost, mcpAppCsp, mcpAppDocument } from "@rakazo/core";
import { cn } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactTarget } from "../lib/artifact-open";
import { fetchArtifactBytes } from "../lib/artifact-open";
import { composerDraftKey, offerComposerText } from "../lib/composer-draft";
import { useAppTheme, useMedia } from "../lib/pages";

type AppBlock = Extract<MessageBlock, { kind: "app" }>;

const MIN_HEIGHT = 80;
export const MCP_APP_MAX_HEIGHT = 640;
/** An app that has not started by then is not shown; the bot's reply stands without it. */
const START_TIMEOUT_MS = 15_000;

async function fetchAppHtml(target: ArtifactTarget, artifactId: string): Promise<string> {
  return new TextDecoder().decode(await fetchArtifactBytes(target, artifactId));
}

/**
 * An MCP server's app for one tool call, drawn in the sandboxed shell at MCP_APP_VIEWER_PATH:
 * opaque origin, no app cookies or storage, and only the domains it declared that this host
 * allows. It gets the call's arguments and result and can ask for two things, each right after
 * the person clicked or typed in it: open a link (through the usual confirm), and put text in
 * the composer. It cannot call tools.
 */
export function McpAppCard({ block, target }: { block: AppBlock; target: ArtifactTarget }) {
  const { i18n } = useLingui();
  const theme = useAppTheme();
  const touch = useMedia("(pointer: coarse)");
  const { open, dialog } = useExternalLinkOpener();
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [height, setHeight] = useState(0);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const html = useQuery({
    queryKey: ["mcp-app-html", block.artifactId],
    queryFn: () => fetchAppHtml(target, block.artifactId),
    enabled: near,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const excludeHosts = useMemo(() => [window.location.hostname], []);
  // A refetched message is a new object with the same values; the app's session must outlive it.
  const cspKey = JSON.stringify(block.csp ?? {});
  const csp = useMemo(() => mcpAppCsp(JSON.parse(cspKey), excludeHosts), [cspKey, excludeHosts]);
  const latest = useRef(block);
  latest.current = block;
  const appDocument = useMemo(
    () => (html.data === undefined ? null : mcpAppDocument(html.data, csp, excludeHosts)),
    [html.data, csp, excludeHosts],
  );
  const hostContext = useMemo(
    () => ({
      theme,
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { maxHeight: MCP_APP_MAX_HEIGHT },
      locale: i18n.locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: "web",
      deviceCapabilities: { touch, hover: !touch },
    }),
    [theme, i18n.locale, touch],
  );
  // The view's session lasts as long as its document; these change without restarting it.
  const contextRef = useRef(hostContext);
  contextRef.current = hostContext;
  const openRef = useRef(open);
  openRef.current = open;
  const draftKey = useRef(composerDraftKey(target));
  draftKey.current = composerDraftKey(target);

  // Drawn only near the screen: a long chat of apps should not run them all at once.
  useEffect(() => {
    const element = box.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "480px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const host = useMemo(() => {
    if (!appDocument) return null;
    const usedGesture = { current: null as string | null, latest: null as string | null };
    const created = createMcpAppHost({
      input: latest.current.toolArguments,
      result: latest.current.toolResult,
      hostContext: contextRef.current,
      csp,
      send: (message) =>
        frame.current?.contentWindow?.postMessage({ type: "rakazo-app:host", message }, "*"),
      // One action per click or key, and only while this frame still holds the focus.
      allowAction: () => {
        const gesture = usedGesture.latest;
        if (!gesture || gesture === usedGesture.current) return false;
        if (document.activeElement !== frame.current) return false;
        usedGesture.current = gesture;
        return true;
      },
      openLink: (url) => openRef.current(url),
      offerMessage: (text) => offerComposerText(draftKey.current, text),
      onHeight: (next) =>
        setHeight(Math.min(Math.max(Math.ceil(next), MIN_HEIGHT), MCP_APP_MAX_HEIGHT)),
    });
    return { ...created, usedGesture };
  }, [appDocument, csp]);

  useEffect(() => {
    if (!host) return;
    function receive(event: MessageEvent) {
      if (!host || event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: unknown; message?: unknown; gesture?: unknown };
      if (data?.type !== "rakazo-app:view") return;
      host.usedGesture.latest = typeof data.gesture === "string" ? data.gesture : null;
      const message = data.message as { method?: unknown };
      if (message?.method === "ui/initialize") setStarted(true);
      host.receive(data.message);
    }
    listenWindow("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      host.teardown();
    };
  }, [host]);

  // A running view hears about later changes instead of restarting.
  useEffect(
    () =>
      host?.updateContext({
        theme: hostContext.theme,
        locale: hostContext.locale,
        deviceCapabilities: hostContext.deviceCapabilities,
      }),
    [host, hostContext],
  );

  useEffect(() => {
    if (!appDocument || started) return;
    const timer = window.setTimeout(() => setFailed(true), START_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [appDocument, started]);

  if (html.isError || failed) return null;
  const bordered = block.prefersBorder !== false;
  return (
    <div ref={box} className="w-[552px] max-w-full" data-testid="mcp-app">
      <div className="mb-1.5 px-1 text-label text-muted-foreground" dir="auto">
        {block.server}
      </div>
      <div
        className={cn("overflow-hidden", bordered && "rounded-2xl border border-border bg-card")}
      >
        {appDocument ? (
          <iframe
            ref={frame}
            title={block.server}
            src={hostViewerUrl(MCP_APP_VIEWER_PATH)}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            onLoad={() =>
              frame.current?.contentWindow?.postMessage(
                { type: "rakazo-app:load", ...appDocument },
                "*",
              )
            }
            style={{ height: started && height ? height : MIN_HEIGHT * 2 }}
            // The shell declares no colour scheme; matching it keeps the frame see-through.
            className="block w-full border-0 [color-scheme:light]"
          />
        ) : (
          <div style={{ height: MIN_HEIGHT * 2 }} />
        )}
      </div>
      {dialog}
    </div>
  );
}
