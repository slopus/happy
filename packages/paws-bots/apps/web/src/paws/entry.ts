import type { HostOptions } from "./runtime";
import { connect, disconnect } from "./runtime";
export function mount(element: HTMLElement, options: HostOptions): () => void {
  let cancelled = false;
  let unmount: (() => void) | undefined;
  element.dataset.pawsBots = "";
  element.dataset.pawsShortcuts = "local";
  element.style.height = "100%";
  element.style.minHeight = "0";
  element.style.position = "relative";
  element.style.overflow = "hidden";
  element.style.isolation = "isolate";
  element.style.transform = "translateZ(0)";
  for (const [name, value] of Object.entries(options.theme ?? {})) element.style.setProperty(name, value);
  void connect(element, options).then(async () => {
    if (cancelled) return;
    const { renderEmbedded } = await import("./embedded-app");
    if (cancelled) return;
    unmount = renderEmbedded(element, options);
  }).catch((error) => { console.error("Bots mount failed", error instanceof Error ? error.message : "Unknown error"); if (!cancelled) { disconnect(); options.onFailure(); } });
  return () => { if (cancelled) return; cancelled = true; unmount?.(); disconnect(); element.replaceChildren(); };
}
