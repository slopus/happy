import { listenWindow } from "../../paws/runtime";
import { hostNavigate } from "../../paws/runtime";
import { useCallback, useEffect, useRef } from "react";
import { discardPrimedBootstrap, primeSpaceBootstrap } from "../../lib/bootstrap";
import { initialBootstrapTarget } from "../../lib/bootstrap-target";
import { getSnapshot as getCallSnapshot } from "../../lib/call-session";
import { leaveOrganization } from "../../lib/organizations";
import { queryClient, spaceSeedKey } from "../../lib/query";
import { selectedSpaceId, selectSpace } from "../../lib/rpc";
import { remountShellForSpace, spaceSwitchDecision } from "../../lib/space-switch";
import { speaker } from "../../lib/tts";
import { readShellOverlay, searchString, withShellOverlay } from "../shell-overlay";
import type { useShellNavigation } from "./use-shell-navigation";

/**
 * Opens a chat in any of the user's spaces, including another organization's; another space loads
 * first, then the shell remounts into it.
 */
export function useOpenSpaceChat({
  bootstrapSpaceId,
  userId,
  navigate,
  navigationRevision,
  overlayRevision,
  closeMobileSidebar,
}: {
  bootstrapSpaceId: string | undefined;
  userId: string | undefined;
  navigate: ReturnType<typeof useShellNavigation>["navigate"];
  navigationRevision: ReturnType<typeof useShellNavigation>["navigationRevision"];
  overlayRevision: ReturnType<typeof useShellNavigation>["overlayRevision"];
  closeMobileSidebar: () => void;
}) {
  const spaceSwitchRequest = useRef(0);
  useEffect(() => {
    const onPopState = () => {
      spaceSwitchRequest.current += 1;
    };
    listenWindow("popstate", onPopState);
    return () => {
      // A switch still loading when this shell goes away (another page, or a
      // newer switch) must not pull the user back to its space afterwards.
      spaceSwitchRequest.current += 1;
      window.removeEventListener("popstate", onPopState);
    };
  }, []);
  return useCallback(
    (spaceId: string, path: string) => {
      closeMobileSidebar();
      const request = ++spaceSwitchRequest.current;
      const startedNavigation = navigationRevision.current;
      const startedOverlay = overlayRevision.current;
      const startedIndex = window.history.state?.idx;
      const previousEffective = selectedSpaceId() ?? bootstrapSpaceId;
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      if (previousEffective === spaceId) {
        if (selectSpace(spaceId)) navigate(path);
        return;
      }
      const reload = () => {
        void leaveOrganization(userId ?? null, previousEffective, spaceId).then(() => {
          if (request !== spaceSwitchRequest.current) return;
          if (selectSpace(spaceId)) hostNavigate(destination());
        });
      };
      const destination = () =>
        overlayRevision.current === startedOverlay
          ? path
          : `${path}${searchString(withShellOverlay(new URLSearchParams(), readShellOverlay(new URLSearchParams(window.location.search))))}`;
      // Another space is an auth boundary: its bootstrap is loaded first, under that
      // space's header, then the shell remounts so none of this space's state survives.
      // A call in progress, or a page outside the shell, still reloads.
      const target = initialBootstrapTarget(path, false);
      if (!target || getCallSnapshot()) {
        reload();
        return;
      }
      const startedAt = window.location.pathname;
      const decision = () =>
        spaceSwitchDecision(
          request === spaceSwitchRequest.current &&
            startedNavigation === navigationRevision.current &&
            startedIndex === window.history.state?.idx,
          startedAt,
          window.location.pathname,
          Boolean(getCallSnapshot()),
        );
      const current = () => decision() !== "abandon";
      // A space visited before opens at once with what it showed then, refreshing behind it.
      const cached = queryClient.getQueryData(spaceSeedKey(userId ?? null, spaceId));
      const primed = primeSpaceBootstrap(spaceId, target.botId, cached);
      const remount = () =>
        remountShellForSpace(() => {
          const action = decision();
          if (action !== "commit") {
            discardPrimedBootstrap(primed);
            if (action === "reload") {
              // Leave the view-transition update before starting a full navigation.
              window.setTimeout(() => {
                if (current()) reload();
              }, 0);
            }
            return false;
          }
          if (!selectSpace(spaceId)) {
            discardPrimedBootstrap(primed);
            return false;
          }
          void leaveOrganization(userId ?? null, previousEffective, spaceId);
          // Playback belongs to the conversation being left.
          speaker.stop();
          navigate(destination());
          return true;
        });
      if (cached) {
        remount();
        return;
      }
      primed.then(
        () => {
          if (!current()) {
            discardPrimedBootstrap(primed);
            return;
          }
          // A call started while the bootstrap loaded belongs to this space.
          if (getCallSnapshot()) {
            discardPrimedBootstrap(primed);
            reload();
            return;
          }
          remount();
        },
        () => {
          discardPrimedBootstrap(primed);
          if (current()) reload();
        },
      );
    },
    [bootstrapSpaceId, navigate, navigationRevision, overlayRevision, userId],
  );
}
