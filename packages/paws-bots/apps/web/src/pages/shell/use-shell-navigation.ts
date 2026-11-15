import type { Bot, Group } from "@rakazo/contracts";
import { chatSnoozed } from "@rakazo/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { NavigateFunction, NavigateOptions, To } from "react-router-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { guardShellNavigate } from "../../lib/space-switch";
import type { ShellOverlay } from "../shell-overlay";
import {
  readShellOverlay,
  searchString,
  shellOverlaySearch,
  withShellOverlay,
} from "../shell-overlay";

/** Router access for the shell: navigation stops once it unmounts, and overlays live in the URL. */
export function useShellNavigation() {
  const routerNavigate = useNavigate();
  const navigateRef = useRef(routerNavigate);
  navigateRef.current = routerNavigate;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const navigationRevision = useRef(0);
  const overlayRevision = useRef(0);
  const guardedNavigate = useMemo(
    () =>
      guardShellNavigate(
        () => navigateRef.current,
        () => alive.current,
      ),
    [],
  );
  const navigate = useMemo<NavigateFunction>(
    () => (to: To | number, options?: NavigateOptions) => {
      navigationRevision.current += 1;
      return typeof to === "number" ? guardedNavigate(to) : guardedNavigate(to, options);
    },
    [guardedNavigate],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  // Mirrors searchParams for effects that only need to read it once on run,
  // not re-run on every unrelated query-param change (e.g. the SSE subscribe
  // effect, which should only restart when the active bot changes).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  /** Automatic route repair preserves overlays without counting as newer user navigation. */
  const redirectKeepingOverlay = useCallback(
    (pathname: string) =>
      guardedNavigate(
        { pathname, search: shellOverlaySearch(searchParamsRef.current) },
        { replace: true },
      ),
    [guardedNavigate],
  );
  const overlay = readShellOverlay(searchParams);
  // Overlays replace the URL rather than adding history, so opening and closing never race a navigation.
  function setOverlay(next: ShellOverlay) {
    overlayRevision.current += 1;
    guardedNavigate(
      { search: searchString(withShellOverlay(searchParams, next)) },
      { replace: true },
    );
  }
  return {
    navigate,
    navigationRevision,
    overlayRevision,
    alive,
    searchParams,
    setSearchParams,
    searchParamsRef,
    redirectKeepingOverlay,
    overlay,
    setOverlay,
  };
}

/** The chat to land on: the first one in the list, so not a snoozed one while any other is listed. */
export function firstThreadRoute(
  bots: readonly Pick<Bot, "id" | "snoozedUntil">[],
  groups: readonly Pick<Group, "id" | "snoozedUntil">[],
  now = Date.now(),
): string {
  const listed = <T extends { snoozedUntil?: string | null }>(chats: readonly T[]) =>
    chats.find((chat) => !chatSnoozed(chat, now));
  const bot = listed(bots);
  if (bot) return `/app/${bot.id}`;
  const group = listed(groups);
  if (group) return `/app/g/${group.id}`;
  if (bots[0]) return `/app/${bots[0].id}`;
  if (groups[0]) return `/app/g/${groups[0].id}`;
  return "/app";
}
