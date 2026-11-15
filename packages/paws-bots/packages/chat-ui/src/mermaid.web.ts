import type { ResolvedAppearance } from "@rakazo/ui-tokens";
import { webTokensForAppearance } from "@rakazo/ui-tokens";
import type mermaid from "mermaid";
import { useEffect, useState, useSyncExternalStore } from "react";
import { chatMermaidConfig } from "./mermaid";

type Mermaid = typeof mermaid;

// Mermaid is large. It loads the first time a message contains a diagram, never with the chat.
let mermaidLoad: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  mermaidLoad ??= import("mermaid").then(
    (module) => module.default,
    (error: unknown) => {
      // A failed chunk load is retried by the next diagram instead of failing every later one.
      mermaidLoad = undefined;
      throw error;
    },
  );
  return mermaidLoad;
}

// Mermaid keeps one global config, so one diagram renders at a time with its own theme.
let renderQueue: Promise<unknown> = Promise.resolve();

function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task, task);
  renderQueue = run.catch(() => undefined);
  return run;
}

export const MERMAID_RENDER_TIMEOUT_MS = 15_000;

const MAX_RENDERED = 64;
// Source that does not parse is remembered as null, so it is not parsed again on every redraw.
const rendered = new Map<string, string | null>();
let renderCount = 0;

function renderKey(source: string, appearance: ResolvedAppearance) {
  return `${appearance}\n${source}`;
}

function remember(key: string, svg: string | null) {
  rendered.delete(key);
  rendered.set(key, svg);
  if (rendered.size > MAX_RENDERED) {
    const oldest = rendered.keys().next().value;
    if (oldest !== undefined) rendered.delete(oldest);
  }
}

/** The diagram as SVG markup, or null when the source is not a diagram Mermaid can draw. */
export function renderMermaidSvg(
  source: string,
  appearance: ResolvedAppearance,
): Promise<string | null> {
  const key = renderKey(source, appearance);
  const known = rendered.get(key);
  if (known !== undefined) return Promise.resolve(known);
  return inTurn(async () => {
    // The same diagram twice on screen queues twice; the second takes the first one's drawing.
    const drawn = rendered.get(key);
    if (drawn !== undefined) return drawn;
    const load = loadMermaid();
    const id = `rk-mermaid-${++renderCount}`;
    let loading = true;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      // Mermaid measures in a scratch node on <body>; a throw can leave it behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    };
    const draw = async () => {
      const mermaid = await load;
      loading = false;
      if (timedOut) return null;
      mermaid.initialize(chatMermaidConfig(webTokensForAppearance(appearance), appearance));
      try {
        if ((await mermaid.parse(source, { suppressErrors: true })) && !timedOut) {
          return (await mermaid.render(id, source)).svg;
        }
        return null;
      } catch {
        return null;
      } finally {
        cleanup();
      }
    };
    try {
      const svg = await Promise.race([
        draw(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            if (loading && mermaidLoad === load) mermaidLoad = undefined;
            resolve(null);
          }, MERMAID_RENDER_TIMEOUT_MS);
        }),
      ]);
      // A later mount may retry a timed-out chunk load or render.
      if (!timedOut) remember(key, svg);
      return svg;
    } finally {
      clearTimeout(timer);
      cleanup();
    }
  });
}

function readAppearance(): ResolvedAppearance {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function subscribeAppearance(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/**
 * The SVG for a diagram in the page's current theme. Undefined while it renders and null when it
 * cannot be drawn; the caller shows the code block in both cases, so the source is never lost.
 */
export function useMermaidSvg(source: string): string | null | undefined {
  const appearance = useSyncExternalStore<ResolvedAppearance>(
    subscribeAppearance,
    readAppearance,
    () => "dark",
  );
  const key = renderKey(source, appearance);
  const [result, setResult] = useState<{ key: string; svg: string | null }>();
  useEffect(() => {
    let current = true;
    renderMermaidSvg(source, appearance).then(
      (svg) => {
        if (current) setResult({ key, svg });
      },
      () => {
        if (current) setResult({ key, svg: null });
      },
    );
    return () => {
      current = false;
    };
  }, [source, appearance, key]);
  if (result?.key === key) return result.svg;
  return rendered.get(key);
}
