import type { LogoAvatarActivity } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

interface Layer {
  key: number;
  activity: LogoAvatarActivity;
  entering: boolean;
  outgoing: boolean;
  opacity: number;
}

/**
 * Infinite CSS tracks share elapsed active time. A changed activity never restarts
 * that clock. Two continuing poses crossfade briefly, with zero opacity velocity
 * at the fade endpoints; no JavaScript runs on animation frames.
 */
export function useLogoAvatarLayers(
  ref: RefObject<SVGSVGElement | null>,
  activity: LogoAvatarActivity,
  running: boolean,
  animated: boolean,
) {
  const serial = useRef(0);
  const clock = useRef<{ last: number; elapsed: number; running: boolean } | null>(null);
  const knownFades = useRef(new WeakSet<Animation>());
  const [layers, setLayers] = useState<Layer[]>([
    { key: 0, activity, entering: false, outgoing: false, opacity: 1 },
  ]);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const current = layers.at(-1)!;
    if (current.activity === activity) {
      if (!running && (layers.length > 1 || current.entering)) {
        setLayers([{ ...current, entering: false, outgoing: false, opacity: 1 }]);
      }
      return;
    }
    const next: Layer = {
      // Static/reduced/offscreen poses reuse their SVG definitions and body DOM.
      key: running ? ++serial.current : current.key,
      activity,
      entering: running,
      outgoing: false,
      opacity: 1,
    };
    const outgoing = running
      ? layers.flatMap((layer) => {
          // An interrupted transition must not extend an older exit's lifetime.
          // Keep its original opacity origin and CSS clock until animationend.
          if (layer.outgoing) return [layer];
          const element = ref.current?.querySelector(`[data-logo-layer="${layer.key}"]`);
          const opacity = element ? Number(getComputedStyle(element).opacity) : 0;
          return opacity > 0 ? [{ ...layer, entering: false, outgoing: true, opacity }] : [];
        })
      : [];
    setLayers([...outgoing, next]);
  }, [activity, layers, ref, running]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const now = Number(document.timeline?.currentTime ?? 0);
    const previous = clock.current;
    const elapsed = previous
      ? previous.elapsed + (previous.running ? Math.max(0, now - previous.last) : 0)
      : 0;
    clock.current = { last: now, elapsed, running };
    // Static avatars have no tracks to sync; skipping avoids a style flush per change.
    if (!animated) return;
    for (const animation of element.getAnimations?.({ subtree: true }) ?? []) {
      if (animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY) {
        if (running) animation.startTime = now - elapsed;
        else animation.currentTime = elapsed;
      } else if (!knownFades.current.has(animation)) {
        animation.startTime = now;
        knownFades.current.add(animation);
      }
    }
  }, [animated, layers, ref, running]);

  const finish = useCallback((key: number, name: string) => {
    if (name === "logo-avatar-layer-out")
      setLayers((previous) => previous.filter((layer) => layer.key !== key));
    if (name === "logo-avatar-layer-in")
      setLayers((previous) =>
        previous.map((layer) => (layer.key === key ? { ...layer, entering: false } : layer)),
      );
  }, []);
  return { layers, finish };
}
