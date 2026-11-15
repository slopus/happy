import { useEffect, useRef } from "react";
import { desktopBridge } from "./desktop";

export function useDesktopBadge(count: number) {
  const badge = desktopBridge()?.badge;
  const lastCount = useRef<number | undefined>(undefined);
  useEffect(() => {
    return () => {
      if (badge && lastCount.current !== 0) void badge.set(0).catch(() => undefined);
      lastCount.current = undefined;
    };
  }, [badge]);
  useEffect(() => {
    if (!badge || lastCount.current === count) return;
    lastCount.current = count;
    void badge.set(count).catch(() => undefined);
  }, [badge, count]);
}
