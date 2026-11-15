import { Trans, useLingui } from "@lingui/react/macro";
import type { SettingsScope } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useSpaceQueries } from "../../lib/query";
import { formatRelativeTime } from "../../lib/relative-time";
import { siteHost } from "./kinds";
import { VaultPageHeader } from "./VaultPageHeader";

function useVaultItemUses(scope: SettingsScope, name: string) {
  const queries = useSpaceQueries();
  return useQuery(queries.vault.activity.queryOptions({ input: { scope, name } }));
}

function ActivityError({ retry }: { retry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 text-body-sm">
      <span className="text-destructive">
        <Trans>Could not load activity</Trans>
      </span>
      <Button type="button" variant="outline" size="sm" onClick={retry}>
        <Trans>Retry</Trans>
      </Button>
    </div>
  );
}

/** The item's latest use, once there is one, as a row that opens every use on its own page. */
export function VaultItemActivity({
  scope,
  name,
  onOpen,
}: {
  scope: SettingsScope;
  name: string;
  onOpen: () => void;
}) {
  const uses = useVaultItemUses(scope, name);
  if (uses.isError) return <ActivityError retry={() => void uses.refetch()} />;
  const latest = uses.data?.[0];
  if (!latest) return null;
  const when = formatRelativeTime(latest.at);
  const bot = latest.botName;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="vault-item-activity"
      className="self-start px-0 text-body-sm text-muted-foreground hover:bg-transparent"
      onClick={onOpen}
    >
      <Trans>
        Used {when} by {bot}
      </Trans>
      <ChevronRight className="rtl:rotate-180" />
    </Button>
  );
}

export function VaultItemUses({
  scope,
  name,
  title,
  onBack,
}: {
  scope: SettingsScope;
  name: string;
  title: string;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const uses = useVaultItemUses(scope, name);
  return (
    <div data-testid="vault-item-uses" className="flex flex-col gap-4">
      <VaultPageHeader title={title} subtitle={t`Activity`} onBack={onBack} />
      {uses.isError ? (
        <ActivityError retry={() => void uses.refetch()} />
      ) : (
        <ul className="overflow-hidden rounded-xl bg-muted/50">
          {(uses.data ?? []).map((use, index) => (
            <li
              key={`${use.at}-${index}`}
              data-testid="vault-item-use"
              className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-body-sm first:border-t-0"
            >
              <span className="min-w-0 flex-1 truncate">
                {use.botName}
                {use.chat && use.chat.title !== use.botName ? (
                  <span className="text-muted-foreground"> · {use.chat.title}</span>
                ) : null}
              </span>
              {use.site ? (
                <span className="truncate text-muted-foreground">{siteHost(use.site)}</span>
              ) : null}
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatRelativeTime(use.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
