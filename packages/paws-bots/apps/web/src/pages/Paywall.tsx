import { hostNavigate } from "../paws/runtime";
import { Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useState } from "react";
import { AccountMenu } from "../components/AccountMenu";
import { CreditChoice } from "../components/ModelCredits";
import { formatBillingPrice } from "../lib/billing";
import type { RpcClient } from "../lib/rpc";
import { useSignOut } from "../lib/sign-out";
import { AuthFrame, submitClass } from "./Auth";

export function PaywallPage({
  status,
  client,
  dismissible = false,
}: {
  status: BillingStatus;
  /** The space `status` was read for, so a choice bills the organization whose prices show. */
  client: RpcClient;
  /** Opened from the app rather than required, so it closes instead of logging out. */
  dismissible?: boolean;
}) {
  return status.funding !== undefined ? (
    <CreditChoice status={status} client={client} dismissible={dismissible} />
  ) : (
    <LegacyPaywallPage status={status} client={client} />
  );
}

function LegacyPaywallPage({ status, client }: { status: BillingStatus; client: RpcClient }) {
  const { t, i18n } = useLingui();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signingOut, logOut } = useSignOut("/sign-in", setError);
  // An unpaid or paused subscription resumes from the portal; a new checkout would bill twice.
  const resumable = status.state === "unpaid" || status.state === "paused";
  const showCheckout = status.canManage && !resumable;
  const showPortal =
    status.canManage &&
    status.hasCustomer &&
    (resumable ||
      status.state === "past_due" ||
      status.state === "incomplete" ||
      status.state === "canceled");

  async function open(target: "checkout" | "portal") {
    if (pending || signingOut) return;
    setPending(true);
    setError(null);
    try {
      const { url } = await (target === "checkout"
        ? client.billing.checkout()
        : client.billing.portal());
      hostNavigate(url);
    } catch {
      setError(t`Could not open billing`);
    } finally {
      // Desktop opens the URL in the system browser and this page stays, so re-enable.
      setPending(false);
    }
  }

  const trialDays = status.trialDays;
  const included = [
    t`Bots with their own computer and browser`,
    t`Routines that run while you're away`,
    t`Any model, with your own key`,
    t`Web, desktop and mobile apps`,
  ];
  const title =
    status.canManage && status.price
      ? formatBillingPrice(status.price, i18n.locale || "en")
      : t`Subscription required`;

  return (
    <AuthFrame
      title={title}
      onSubmit={(event) => {
        event.preventDefault();
        if (showCheckout) void open("checkout");
        else if (showPortal) void open("portal");
      }}
    >
      <div data-testid="billing-paywall" className="flex w-full flex-col items-center">
        {error ? (
          <p role="alert" className="mb-3 w-full text-body text-destructive">
            {error}
          </p>
        ) : null}
        {status.canManage ? (
          <ul className="mb-9 flex flex-col gap-3 text-body-lg">
            {included.map((item) => (
              <li key={item} className="flex items-center gap-3">
                <Check aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                {item}
              </li>
            ))}
          </ul>
        ) : null}
        {showCheckout ? (
          <Button type="submit" size="lg" disabled={pending || signingOut} className={submitClass}>
            {status.trialAvailable ? (
              <Trans>Start {trialDays}-day free trial</Trans>
            ) : (
              <Trans>Subscribe</Trans>
            )}
          </Button>
        ) : null}
        {showPortal ? (
          <Button
            type="button"
            size="lg"
            variant={showCheckout ? "secondary" : "default"}
            disabled={pending || signingOut}
            className={submitClass}
            onClick={() => void open("portal")}
          >
            <Trans>Manage billing</Trans>
          </Button>
        ) : null}
        <AccountMenu disabled={pending} signingOut={signingOut} onLogOut={() => void logOut()} />
      </div>
    </AuthFrame>
  );
}
