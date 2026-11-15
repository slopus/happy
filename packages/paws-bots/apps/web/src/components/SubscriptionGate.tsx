import { listenWindow } from "../paws/runtime";
import { useLingui } from "@lingui/react/macro";
import type { BillingStatus, Me } from "@rakazo/contracts";
import { Dialog, DialogContent } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { createContext, Suspense, useContext, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { peekInitialBootstrap } from "../lib/bootstrap";
import { lazyComponent } from "../lib/preload-recovery";
import { loadBillingStatus } from "../lib/referral";
import type { RpcClient } from "../lib/rpc";
import { createSpaceRpc, rpc, SPACE_SELECTED_EVENT, selectedSpaceId } from "../lib/rpc";
import type { SupportChat } from "../lib/support-chat";
import { useSupportChat } from "../lib/support-chat";

const PaywallPage = lazyComponent(() =>
  import("../pages/Paywall").then((module) => module.PaywallPage),
);

// A status keeps the client of the space it was read for: another tab can select another
// organization, and a plan choice must bill the one whose prices are on screen.
type GateState =
  | { kind: "loading" }
  | { kind: "open"; status?: BillingStatus; client?: RpcClient }
  | { kind: "paywall"; status: BillingStatus; client: RpcClient };

const BillingContext = createContext<{ status: BillingStatus | null; showPlans: () => void }>({
  status: null,
  showPlans: () => undefined,
});

/** The latest billing status (`null` when the deployment does not bill) and the plan choice. */
export function useBilling() {
  return useContext(BillingContext);
}

function loadMe(): Promise<Me> {
  const primed = peekInitialBootstrap();
  if (!primed) return rpc.me();
  return primed.then(
    (bootstrap) => bootstrap.me,
    () => rpc.me(),
  );
}

function gateFor(status: BillingStatus, client: RpcClient): GateState {
  return { kind: status.access ? "open" : "paywall", status, client };
}

/**
 * Holds the app behind the paywall when the deployment bills. Self-hosted
 * installs only make the capabilities request. Enforcement belongs to the API,
 * so a failed lookup here falls through to the app.
 */
export function SubscriptionGate({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const [state, setState] = useState<GateState>({ kind: "loading" });
  // This tab's organization. Another tab can select another one at any time; only a switch made
  // here (SPACE_SELECTED_EVENT) moves billing with it.
  const tabSpaceId = useRef<string | null>(null);
  const [supportChat, setSupportChat] = useState<SupportChat | null>(null);
  const { t } = useLingui();
  // `?plans` links straight to the plan choice.
  const [searchParams, setSearchParams] = useSearchParams();
  const plansOpen = searchParams.has("plans");
  const setPlansOpen = (open: boolean) =>
    setSearchParams((params) => {
      if (open) params.set("plans", "");
      else params.delete("plans");
      return params;
    });

  useEffect(() => {
    let active = true;
    fetchAuthCapabilities()
      .then(async (capabilities): Promise<GateState> => {
        if (!capabilities.billing) return { kind: "open" };
        const me = await loadMe();
        if (!me.billingEnabled) return { kind: "open" };
        // Without a saved selection the server picked `me.spaceId`; naming it keeps billing on
        // it, so a deleted or left organization is rejected rather than resolved to another one.
        tabSpaceId.current = selectedSpaceId() ?? me.spaceId;
        const client = createSpaceRpc(tabSpaceId.current);
        const status = await loadBillingStatus(client);
        if (active && capabilities.crispWebsiteId) {
          setSupportChat({
            crispWebsiteId: capabilities.crispWebsiteId,
            email: me.email,
            name: me.name,
          });
        }
        return gateFor(status, client);
      })
      .catch((): GateState => ({ kind: "open" }))
      .then((next) => {
        if (active) setState(next);
      });
    return () => {
      active = false;
    };
  }, []);

  // Once billing has answered, checks keep running, even after a later read fails and the gate
  // drops its status.
  const [billed, setBilled] = useState(false);
  if (!billed && state.kind !== "loading" && state.status !== undefined) setBilled(true);
  useEffect(() => {
    if (!billed) return;
    // Checkout can finish in another window (the system browser on desktop), and a free period
    // can end while the app is open.
    let active = true;
    // Numbered, so an older read (say, for the Space just left) never replaces a newer one.
    let latest = 0;
    const recheck = (onFailure?: () => void) => {
      if (document.visibilityState === "hidden") return;
      const read = ++latest;
      const client = createSpaceRpc(tabSpaceId.current);
      client.billing
        .status()
        .then((status) => {
          if (active && read === latest) setState(gateFor(status, client));
        })
        .catch(() => {
          if (active && read === latest) onFailure?.();
        });
    };
    const onFocus = () => recheck();
    // Another Space can belong to another organization with its own invite link and plan: the
    // previous one's link is dropped at once, and billing reloads for the new one.
    // If the new Space's read fails, nothing of the previous one stays: the app opens without a
    // status, as on any failed lookup, since the API enforces access.
    const spaceSelected = () => {
      tabSpaceId.current = selectedSpaceId();
      setState((current) =>
        current.kind !== "loading" && current.status
          ? { ...current, status: { ...current.status, referral: null } }
          : current,
      );
      recheck(() => setState({ kind: "open" }));
    };
    listenWindow("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    listenWindow(SPACE_SELECTED_EVENT, spaceSelected);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener(SPACE_SELECTED_EVENT, spaceSelected);
    };
  }, [billed]);

  // On the required paywall only: the plans dialog blocks pointer input outside itself.
  useSupportChat(state.kind === "paywall" ? supportChat : null);

  if (state.kind === "loading") return fallback;
  if (state.kind === "paywall") {
    return (
      <Suspense fallback={fallback}>
        <PaywallPage status={state.status} client={state.client} />
      </Suspense>
    );
  }
  return (
    <BillingContext.Provider
      value={{ status: state.status ?? null, showPlans: () => setPlansOpen(true) }}
    >
      {children}
      {state.status && state.client ? (
        // Over the app rather than replacing it, so closing keeps its state.
        <Dialog open={plansOpen} onOpenChange={setPlansOpen}>
          <DialogContent
            aria-label={t`Choose how to use Rakazo`}
            className="inset-0 top-0 left-0 block h-dvh max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none bg-background p-0 ring-0 sm:max-w-none"
          >
            <Suspense fallback={fallback}>
              <PaywallPage status={state.status} client={state.client} dismissible />
            </Suspense>
          </DialogContent>
        </Dialog>
      ) : null}
    </BillingContext.Provider>
  );
}
