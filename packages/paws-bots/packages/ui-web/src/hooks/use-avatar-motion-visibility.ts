import { useEffect, useRef, useState } from "react";

type Watcher = { visible: boolean; notify: (visible: boolean, reduced: boolean) => void };
const watchers = new Map<Element, Watcher>();
let observer: IntersectionObserver | undefined;
let reducedMotion: MediaQueryList | undefined;

function notifyVisibility() {
  for (const watcher of watchers.values())
    watcher.notify(watcher.visible && !document.hidden, reducedMotion?.matches ?? false);
}

function watch(element: Element, notify: Watcher["notify"]) {
  if (watchers.size === 0) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", notifyVisibility);
    document.addEventListener("visibilitychange", notifyVisibility);
  }
  if (!observer && typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const watcher = watchers.get(entry.target);
        if (watcher && watcher.visible !== entry.isIntersecting) {
          watcher.visible = entry.isIntersecting;
          watcher.notify(watcher.visible && !document.hidden, reducedMotion?.matches ?? false);
        }
      }
    });
  }
  watchers.set(element, { visible: true, notify });
  notify(!document.hidden, reducedMotion?.matches ?? false);
  observer?.observe(element);
  return () => {
    observer?.unobserve(element);
    watchers.delete(element);
    if (watchers.size === 0) {
      observer?.disconnect();
      observer = undefined;
      document.removeEventListener("visibilitychange", notifyVisibility);
      reducedMotion?.removeEventListener("change", notifyVisibility);
      reducedMotion = undefined;
    }
  };
}

/** One observer and one visibility listener serve every moving avatar on the page. */
export function useAvatarMotionVisibility(enabled: boolean) {
  const ref = useRef<SVGSVGElement>(null);
  const [state, setState] = useState({ visible: true, reduced: false });
  useEffect(() => {
    if (enabled && ref.current)
      return watch(ref.current, (visible, reduced) =>
        setState((previous) =>
          previous.visible === visible && previous.reduced === reduced
            ? previous
            : { visible, reduced },
        ),
      );
  }, [enabled]);
  return { ref, visible: state.visible, reducedMotion: state.reduced };
}
