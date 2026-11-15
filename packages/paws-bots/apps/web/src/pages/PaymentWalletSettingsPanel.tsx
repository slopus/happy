import { Trans, useLingui } from "@lingui/react/macro";
import type { PaymentWalletStatus } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import { Button } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** How often an open sign-in asks whether the provider finished it. */
export const PAYMENT_WALLET_POLL_MS = 3_000;

function openVerification(url: string) {
  // Electron hands a new window to the system browser; a blocked popup leaves the Open button.
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Connects the wallet the user's bots spend from. */
export function PaymentWalletSettingsPanel({
  provider,
}: {
  provider: { id: string; name: string };
}) {
  const { t } = useLingui();
  const name = provider.name;
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const statusOptions = queries.paymentWallet.status.queryOptions();
  // Each read of an open sign-in advances it, so polling stops as soon as it settles.
  const statusQuery = useQuery({
    ...statusOptions,
    refetchInterval: (query) =>
      query.state.data?.status === "connecting" ? PAYMENT_WALLET_POLL_MS : false,
  });
  const status = statusQuery.data;
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownError = error ?? (statusQuery.isError ? t`Couldn't load your wallet` : null);

  async function act(action: () => Promise<PaymentWalletStatus>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const next = await action();
      await writeSaved(queryClient, statusOptions.queryKey, () => next);
      if (next.status === "connecting") openVerification(next.verificationUrl);
    } catch (err) {
      setError(errorText(err, t`Couldn't update your wallet`));
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  const connect = () => void act(() => rpc.paymentWallet.connect());
  const disconnect = () => void act(() => rpc.paymentWallet.disconnect());

  return (
    <div data-testid="payment-wallet-settings" className="space-y-3">
      {shownError ? (
        <p role="alert" className="text-body-sm text-destructive">
          {shownError}
        </p>
      ) : null}
      {status ? (
        <SettingsGroup>
          <SettingsRow
            label={
              <>
                <p className="break-words">{name}</p>
                {status.status === "connecting" ? (
                  <p
                    data-testid="payment-wallet-code"
                    className="mt-1 font-mono text-heading2 tracking-[0.2em] text-foreground"
                  >
                    {status.userCode}
                  </p>
                ) : null}
              </>
            }
            control={
              status.status === "disconnected" ? (
                <Button size="sm" disabled={pending} onClick={connect}>
                  <Trans>Connect</Trans>
                </Button>
              ) : status.status === "connecting" ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => openVerification(status.verificationUrl)}
                  >
                    <ExternalLink aria-hidden="true" />
                    <Trans>Open</Trans>
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={disconnect}>
                    <Trans>Cancel</Trans>
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirming(true)}
                >
                  <Trans>Disconnect</Trans>
                </Button>
              )
            }
          />
        </SettingsGroup>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          onCancel={() => setConfirming(false)}
          title={t`Disconnect ${name}?`}
          busy={pending}
          onConfirm={disconnect}
          confirmLabel={<Trans>Disconnect</Trans>}
        />
      ) : null}
    </div>
  );
}
