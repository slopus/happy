import { hostRoot } from "../../paws/runtime";
import type { TouchEvent } from "react";
import { useEffect, useRef, useState } from "react";

const MOBILE_SIDEBAR_SWIPE_EDGE_PX = 32;
const MOBILE_SIDEBAR_SWIPE_DISTANCE_PX = 56;

function isDesktop() {
  return window.matchMedia("(min-width: 768px)").matches;
}

function isRtl() {
  return hostRoot().getAttribute("dir") === "rtl";
}

/** The phone sidebar drawer, opened by its button or a swipe in from the leading edge. */
export function useMobileSidebar() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const swipeRef = useRef<{ startX: number; startY: number } | null>(null);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    function closeMobileSidebar() {
      if (desktop.matches) setMobileSidebarOpen(false);
    }
    closeMobileSidebar();
    desktop.addEventListener("change", closeMobileSidebar);
    return () => desktop.removeEventListener("change", closeMobileSidebar);
  }, []);

  const swipeHandlers = {
    onTouchStartCapture: (event: TouchEvent) => {
      if (mobileSidebarOpen || event.touches.length !== 1 || isDesktop()) {
        swipeRef.current = null;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      const startsAtEdge = isRtl()
        ? touch.clientX >= window.innerWidth - MOBILE_SIDEBAR_SWIPE_EDGE_PX
        : touch.clientX <= MOBILE_SIDEBAR_SWIPE_EDGE_PX;
      swipeRef.current = startsAtEdge ? { startX: touch.clientX, startY: touch.clientY } : null;
    },
    onTouchEndCapture: (event: TouchEvent) => {
      const swipe = swipeRef.current;
      swipeRef.current = null;
      const touch = event.changedTouches[0];
      if (!swipe || !touch || mobileSidebarOpen || isDesktop()) {
        return;
      }
      const horizontal = isRtl() ? swipe.startX - touch.clientX : touch.clientX - swipe.startX;
      const vertical = Math.abs(touch.clientY - swipe.startY);
      if (horizontal >= MOBILE_SIDEBAR_SWIPE_DISTANCE_PX && horizontal > vertical * 1.25) {
        setMobileSidebarOpen(true);
      }
    },
    onTouchCancelCapture: () => {
      swipeRef.current = null;
    },
  };

  return { mobileSidebarOpen, setMobileSidebarOpen, swipeHandlers };
}
