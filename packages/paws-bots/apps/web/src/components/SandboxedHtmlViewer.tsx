import { hostViewerUrl, listenWindow } from "../paws/runtime";
import { HTML_VIEWER_PATH } from "@rakazo/contracts/content-security-policy";
import { useEffect, useRef, useState } from "react";

export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";

const PREVIEW_GUARD = `<script>
document.addEventListener("click", (event) => {
  const target = event.target;
  const link = target instanceof Element ? target.closest("a[href]") : null;
  if (!link) return;
  const href = link.getAttribute("href") ?? "";
  event.preventDefault();
  if (href.startsWith("#")) location.hash = href;
}, true);
document.addEventListener("submit", (event) => event.preventDefault(), true);
</script>`;

function previewDocument(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const referrer = `<meta name="referrer" content="no-referrer">`;
  return `${meta}${referrer}${PREVIEW_GUARD}${html}`;
}

/**
 * The shell at HTML_VIEWER_PATH is a network document, so it does not inherit the app's CSP the
 * way a srcdoc frame would (which would block the preview's inline scripts). It renders the posted
 * document in a nested sandboxed srcdoc frame under the shell's own CSP.
 */
export function SandboxedHtmlViewer({
  html,
  title,
  className = "bg-white",
  onFrameMessage,
}: {
  html: string;
  title: string;
  className?: string;
  /**
   * Messages the shown document sends up through the viewer shell; `answer` posts back down, and
   * `focused` says whether this frame holds the app's focus as the message arrives.
   */
  onFrameMessage?: (data: unknown, answer: (message: object) => void, focused: boolean) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // Every shell load starts empty, so each one gets the document again.
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    // The sandboxed shell has an opaque origin, so there is no narrower target origin to name.
    if (loads > 0) frame.current?.contentWindow?.postMessage(previewDocument(html), "*");
  }, [loads, html]);
  useEffect(() => {
    if (!onFrameMessage) return;
    function receive(event: MessageEvent) {
      // Only this viewer's own frame speaks for its document.
      if (event.source !== frame.current?.contentWindow) return;
      onFrameMessage?.(
        event.data,
        (message) => frame.current?.contentWindow?.postMessage(message, "*"),
        document.activeElement === frame.current,
      );
    }
    listenWindow("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onFrameMessage]);
  return (
    <iframe
      ref={frame}
      title={title}
      src={hostViewerUrl(HTML_VIEWER_PATH)}
      onLoad={() => setLoads((count) => count + 1)}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      // The viewer shell declares no colour scheme. Against a dark app the browser would paint
      // the frame opaque white until the document draws; matching schemes keep it see-through.
      className={`h-full w-full border-0 [color-scheme:light] ${className}`}
    />
  );
}
