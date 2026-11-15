import { hostNavigate } from "../paws/runtime";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import { Button, SectionHeading, Skeleton } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { ModelCreditsSettings } from "../components/ModelCredits";
import { billingDateLabel, formatBillingPrice } from "../lib/billing";
import type { RpcClient } from "../lib/rpc";

/** `client` is the window's space: another tab can select another organization at any time. */
export function BillingSettingsPanel({ client }: { client: RpcClient }) {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || "en";
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    client.billing
      .status()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setError(t`Could not load billing`);
      });
    return () => {
      active = false;
    };
  }, [client, t]);

  async function openPortal() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const { url } = await client.billing.portal();
      hostNavigate(url);
    } catch {
      setError(t`Could not open billing`);
    } finally {
      // Desktop opens the URL in the system browser and this page stays, so re-enable.
      setPending(false);
    }
  }

  const stateLabel = status
    ? status.state === "trialing"
      ? t`Trial`
      : status.state === "active"
        ? t`Active`
        : status.state === "past_due"
          ? t`Past due`
          : status.state === "canceled"
            ? t`Canceled`
            : t`Inactive`
    : null;

  const dateLabel = status ? billingDateLabel(status, locale) : null;

  const price = status?.price ? formatBillingPrice(status.price, locale) : null;
  const seats = status?.seats ?? 0;

  if (status?.funding !== undefined)
    return (
      <ModelCreditsSettings
        status={status}
        refresh={async () => setStatus(await client.billing.status())}
        client={client}
      />
    );

  return (
    <div data-testid="billing-settings" className="rounded-xl border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {status ? (
            <SectionHeading variant="heading">{stateLabel}</SectionHeading>
          ) : error ? null : (
            <Skeleton className="h-5 w-24" />
          )}
          {price ? (
            <p className="mt-3 flex flex-wrap gap-x-2 text-body text-foreground/75">
              <span>{price}</span>
              {seats > 1 ? (
                <span className="text-muted-foreground">
                  <Plural value={seats} one="# seat" other="# seats" />
                </span>
              ) : null}
            </p>
          ) : null}
          {dateLabel ? (
            <p className="mt-2 text-body-sm text-muted-foreground/80">{dateLabel}</p>
          ) : null}
        </div>
        {status?.canManage && status.hasCustomer ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => void openPortal()}
          >
            <Trans>Manage</Trans>
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-body text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
