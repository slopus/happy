import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { CONNECTION_LABEL_MAX_LENGTH } from "@rakazo/contracts";
import { appToolLabel, catalogItemAccounts, catalogItemKey } from "@rakazo/core";
import { Badge, Button, Disclosure, Input } from "@rakazo/ui-web";
import { ChevronLeft, Plus } from "lucide-react";
import type { PluginConnections } from "./use-plugin-connections";

/** A connected app's page: its accounts, adding another, its tools, and uninstalling it. */
export function ConnectorDetail({
  item,
  state,
  onBack,
}: {
  item: ConnectionCatalogItem;
  state: PluginConnections;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const {
    connections,
    pending,
    labelDrafts,
    setLabelDrafts,
    tools,
    toolsLoading,
    connect,
    revokeAccount,
    uninstall,
    renameAccount,
  } = state;
  const accounts = catalogItemAccounts(connections, item);
  const key = catalogItemKey(item);
  const connecting = pending === key;
  const uninstalling = pending === `uninstall:${key}`;
  const toolCount = tools.length;

  return (
    <div data-testid="connection-detail" className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t`Back`}
            onClick={onBack}
          >
            <ChevronLeft />
          </Button>
          {item.logo ? (
            <img
              src={item.logo}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-9 w-9 shrink-0 rounded-xl bg-accent object-contain"
            />
          ) : (
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-body font-semibold text-foreground">
              {item.name[0]}
            </div>
          )}
          <div className="truncate text-heading3 font-medium text-foreground">{item.name}</div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={uninstalling || connecting}
          onClick={() => void uninstall(item)}
        >
          {uninstalling ? <Trans>Removing…</Trans> : <Trans>Uninstall</Trans>}
        </Button>
      </div>

      <section data-testid="connection-accounts" className="space-y-1">
        {accounts.map((row) => (
          <div key={row.id} className="group/account flex items-center gap-2">
            <Input
              value={labelDrafts[row.id] ?? row.displayName}
              aria-label={t`Account label`}
              maxLength={CONNECTION_LABEL_MAX_LENGTH}
              className="h-9 rounded-lg border-transparent bg-transparent px-2 text-body shadow-none hover:bg-accent/60 focus-visible:bg-background dark:bg-transparent"
              onChange={(event) =>
                setLabelDrafts((current) => ({
                  ...current,
                  [row.id]: event.target.value,
                }))
              }
              onBlur={() => void renameAccount(row)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) {
                  if (event.key === "Escape") event.stopPropagation();
                  return;
                }
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
            <Button
              type="button"
              variant="ghost"
              className="h-8 shrink-0 px-2.5 text-label text-muted-foreground pointer-fine:opacity-0 pointer-fine:group-focus-within/account:opacity-100 pointer-fine:group-hover/account:opacity-100"
              size="sm"
              disabled={pending === row.id || uninstalling}
              onClick={() => void revokeAccount(row, item)}
            >
              {pending === row.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          className="h-9 px-2 text-body text-muted-foreground"
          size="sm"
          disabled={connecting || uninstalling}
          onClick={() => void connect(item)}
        >
          <Plus />
          {connecting ? <Trans>Adding…</Trans> : <Trans>Add another</Trans>}
        </Button>
      </section>

      {toolsLoading || tools.length > 0 ? (
        <Disclosure
          data-testid="connection-tools"
          className="px-2"
          summaryClassName="text-body-sm text-muted-foreground"
          summary={
            toolsLoading ? (
              <Trans>Tools</Trans>
            ) : (
              <Plural value={toolCount} one="# tool" other="# tools" />
            )
          }
        >
          <div className="flex flex-wrap gap-1.5 pt-3">
            {tools.map((tool) => (
              <Badge
                key={tool.name}
                variant="secondary"
                className="h-6 px-2.5 text-label font-normal"
                title={tool.description || undefined}
              >
                {appToolLabel(tool.name, item.slug)}
              </Badge>
            ))}
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}
