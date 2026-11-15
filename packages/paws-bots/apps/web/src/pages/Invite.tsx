import { Trans } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { SpaceInvitePreview } from "@rakazo/contracts";
import { Button, cn } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SharedSpaceRules } from "../components/SharedSpaceRules";
import { rpc, selectSpace } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { AuthFrame, submitClass } from "./Auth";

// An invite names its own space, so a remembered one that is no longer available must not
// send the request through space recovery and away from the invite.
const NO_SPACE = { context: { spaceId: null } };

type InviteState =
  | { kind: "loading" }
  | { kind: "ready"; preview: SpaceInvitePreview }
  | { kind: "invalid" }
  | { kind: "error"; message: string };

/** A used, expired, or unknown token is the server refusing the request, not a failure to retry. */
function isInvalidInvite(error: unknown): boolean {
  return error instanceof ORPCError && error.status >= 400 && error.status < 500;
}

export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<InviteState>({ kind: "loading" });
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    rpc.spaces.invites
      .preview({ token }, NO_SPACE)
      .then((preview) => {
        if (!active) return;
        if (preview.alreadyMember) {
          openSpace(preview.spaceId);
          return;
        }
        setState({ kind: "ready", preview });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setState(
          isInvalidInvite(err) ? { kind: "invalid" } : { kind: "error", message: errorText(err) },
        );
      });
    return () => {
      active = false;
    };
  }, [token, attempt]);

  function openSpace(spaceId: string) {
    selectSpace(spaceId);
    navigate("/app", { replace: true });
  }

  async function join(event: React.FormEvent) {
    event.preventDefault();
    if (joining) return;
    setJoining(true);
    setJoinError(null);
    try {
      const { spaceId } = await rpc.spaces.invites.accept({ token }, NO_SPACE);
      openSpace(spaceId);
    } catch (err) {
      if (isInvalidInvite(err)) setState({ kind: "invalid" });
      else setJoinError(errorText(err));
      setJoining(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="grid h-full place-items-center text-muted-foreground/80">
        <Trans>Loading…</Trans>
      </div>
    );
  }

  if (state.kind === "invalid" || state.kind === "error") {
    return (
      <AuthFrame
        title={
          state.kind === "invalid" ? (
            <Trans>This invite link is no longer valid.</Trans>
          ) : (
            state.message
          )
        }
        onSubmit={(event) => {
          event.preventDefault();
          if (state.kind === "error") setAttempt((value) => value + 1);
          else navigate("/app", { replace: true });
        }}
      >
        <Button type="submit" className={submitClass}>
          {state.kind === "invalid" ? <Trans>Open Rakazo</Trans> : <Trans>Retry</Trans>}
        </Button>
      </AuthFrame>
    );
  }

  const { spaceName, inviterName } = state.preview;
  return (
    <AuthFrame title={<Trans>Join {spaceName}</Trans>} onSubmit={join}>
      <p className="-mt-6 text-center text-muted-foreground">
        <Trans>{inviterName} invited you</Trans>
      </p>
      <SharedSpaceRules className="mt-8" />
      {joinError ? (
        <p role="alert" className="mt-3 text-body-sm text-destructive">
          {joinError}
        </p>
      ) : null}
      <Button type="submit" disabled={joining} className={cn(submitClass, "mt-6")}>
        <Trans>Join</Trans>
      </Button>
    </AuthFrame>
  );
}
