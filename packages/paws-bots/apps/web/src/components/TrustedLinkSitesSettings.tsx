import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { useTrustedLinkSites } from "../lib/trusted-link-sites";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/** Sites the user chose to always open from chat links; shown only once there is one. */
export function TrustedLinkSitesSettings() {
  const { t } = useLingui();
  const { sites, remove } = useTrustedLinkSites();
  const [error, setError] = useState<string | null>(null);

  async function removeSite(site: string) {
    setError(null);
    try {
      await remove(site);
    } catch (err) {
      setError(errorText(err, t`Could not continue`));
    }
  }

  if (sites.length === 0) return null;
  return (
    <SettingsGroup title={<Trans>Trusted sites</Trans>} data-testid="trusted-link-sites">
      {sites.map((site) => (
        <SettingsRow
          key={site}
          label={<span className="break-all">{site}</span>}
          control={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              aria-label={t`Remove ${site}`}
              onClick={() => void removeSite(site)}
            >
              <Trans>Remove</Trans>
            </Button>
          }
        />
      ))}
      {error ? (
        <p role="alert" className="px-4 py-3 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
