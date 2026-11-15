import { useLingui } from "@lingui/react/macro";
import type { VaultKind, VaultPolicy } from "@rakazo/contracts";
import { VaultPolicy as Policies } from "@rakazo/contracts";
import { vaultAccessControls, vaultBotChoices } from "@rakazo/core";
import { vaultPolicyLabels } from "@rakazo/i18n/vault";
import { ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import type { AgentAccess } from "../integrations/agent-access";
import { AgentAccessControl } from "../integrations/agent-access";

/**
 * The owner's bots in this Space, which an item can be limited to; undefined until loaded, null
 * if they, or archived ones it is limited to, can't be read. An archived bot the item is limited
 * to is named so, as restoring it brings the choice back.
 */
export function useVaultBots(enabled: boolean, chosen: string[] = []) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const { data, isError } = useQuery({ ...queries.bots.list.queryOptions(), enabled });
  // Archived bots are listed apart; without them, a chosen one can't be shown, so no choice is
  // offered (`vaultAccessControls`) and the choice stays as saved.
  const archived = useQuery({
    ...queries.bots.listArchived.queryOptions(),
    enabled: enabled && chosen.length > 0,
  });
  if (isError && !data) return null;
  if (enabled && chosen.length > 0) {
    // Not listed until they are known, or the item would read as limited to no bots meanwhile;
    // and unreadable if a chosen one can't be named, as for the bots' own list.
    if (archived.isPending) return undefined;
    if (archived.isError && data && chosen.some((id) => !data.some((bot) => bot.id === id)))
      return null;
  }
  const archivedName = (name: string) => `${name} · ${t`Archived`}`;
  return data && vaultBotChoices(data, archived.data ?? [], chosen, archivedName);
}

export function VaultItemAccess({
  kind,
  policy,
  access,
  note,
  disabled,
  onChange,
  onAccessChange,
}: {
  kind: VaultKind;
  policy: VaultPolicy;
  /** Which bots may use it; left out on a server that can't limit an item to chosen bots. */
  access?: AgentAccess;
  /** Said under the bots when only some may use it, or when this Space's can't be chosen. */
  note?: string;
  disabled?: boolean;
  onChange: (next: VaultPolicy) => void;
  onAccessChange: (next: AgentAccess) => void;
}) {
  const { t } = useLingui();
  const labels = vaultPolicyLabels();
  // As the item was saved, so an archived bot let go of stays in the list until saving. Taken
  // when the bots are first offered, which may be after this opened.
  const [saved, setSaved] = useState(access && (access.allBots ? [] : access.botIds));
  if (!saved && access) setSaved(access.allBots ? [] : access.botIds);
  const bots = useVaultBots(Boolean(access), saved) ?? [];
  const controls = vaultAccessControls({ kind, policy, access, bots, note });
  if (!controls.policies.length && !controls.picker && !controls.note) return null;
  return (
    <div data-testid="vault-item-access" className="flex flex-wrap items-center gap-2">
      <span className="text-body-sm text-muted-foreground">{t`Bots`}</span>
      {controls.policies.length ? (
        <ToggleGroup
          aria-label={t`Bots`}
          value={[policy]}
          onValueChange={([next]) => {
            const chosen = Policies.safeParse(next).data;
            if (chosen) onChange(chosen);
          }}
          disabled={disabled}
          spacing={1}
          className="rounded-lg bg-muted p-1"
        >
          {controls.policies.map((option) => (
            <ToggleGroupItem
              key={option}
              value={option}
              className="h-7 px-3 text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              {labels[option]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {controls.picker && access ? (
        <AgentAccessControl
          bots={bots}
          access={access}
          disabled={disabled}
          withOneBot
          onChange={onAccessChange}
        />
      ) : null}
      {controls.note ? (
        <p className="w-full text-body-sm text-muted-foreground">{controls.note}</p>
      ) : null}
    </div>
  );
}
