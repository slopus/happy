import { Trans, useLingui } from "@lingui/react/macro";
import type { ScratchpadItem } from "@rakazo/contracts";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { Button, Checkbox, Input, SectionHeading } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";

const NO_ITEMS: ScratchpadItem[] = [];

export function ScratchpadSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.scratchpad.list.queryOptions({ input: { botId } });
  // The bot edits its open work as it runs, so every open refreshes behind the cached list.
  const items = useQuery({ ...list, refetchOnMount: "always" }).data ?? NO_ITEMS;
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setItems(update: (current: ScratchpadItem[]) => ScratchpadItem[]) {
    return writeSaved(queryClient, list.queryKey, (current) => update(current ?? []));
  }

  async function refresh() {
    await fetchFresh(queryClient, list);
  }

  async function addItem() {
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await rpc.scratchpad.create({ botId, title });
      setDraft("");
      setAdding(false);
      await setItems((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      try {
        await refresh();
      } catch {
        setError(t`Saved, but list refresh failed`);
      }
    } catch {
      setError(t`Could not add`);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(item: ScratchpadItem, status: ScratchpadItem["status"]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.scratchpad.update({ itemId: item.id, status });
      await setItems((current) => {
        const next = current.map((entry) => (entry.id === updated.id ? updated : entry));
        return status === "done" ? next.filter((entry) => entry.status !== "done") : next;
      });
      try {
        await refresh();
      } catch {
        setError(t`Saved, but list refresh failed`);
      }
    } catch {
      setError(t`Could not update`);
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item: ScratchpadItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.scratchpad.remove({ itemId: item.id });
      await setItems((current) => current.filter((entry) => entry.id !== item.id));
      try {
        await refresh();
      } catch {
        setError(t`Removed, but list refresh failed`);
      }
    } catch {
      setError(t`Could not remove`);
    } finally {
      setBusy(false);
    }
  }

  if (!items.length && !error) return null;

  return (
    <div className="mt-6" data-testid="bot-scratchpad">
      <SectionHeading variant="label" className="mb-2 flex items-center justify-between pe-1">
        <Trans>Open work</Trans>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Add open work`}
          title={t`Add open work`}
          onClick={() => setAdding((value) => !value)}
        >
          <Plus className="size-4" />
        </Button>
      </SectionHeading>
      <div className="rounded-xl bg-muted/50 p-4">
        {(showAll ? items : items.slice(0, 5)).map((item) => (
          <div
            key={item.id}
            className="group -mx-2.5 flex items-start gap-2 rounded-lg px-2.5 py-2 hover:bg-accent/50"
          >
            <Checkbox
              aria-label={item.status === "done" ? t`Reopen` : t`Complete`}
              checked={item.status === "done"}
              disabled={busy}
              onCheckedChange={(checked) => void setStatus(item, checked ? "done" : "open")}
              className="mt-[3px]"
            />
            <div className="min-w-0 flex-1">
              <div
                className={`text-start text-body-lg ${item.status === "done" ? "text-muted-foreground/80 line-through" : "text-foreground"}`}
                dir="auto"
              >
                {item.title}
              </div>
              {item.notes ? (
                <div className="mt-0.5 text-body-sm text-muted-foreground/80" dir="auto">
                  {item.notes}
                </div>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Remove`}
              disabled={busy}
              onClick={() => void removeItem(item)}
              className="-mt-0.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <X />
            </Button>
          </div>
        ))}
        {items.length > 5 && !showAll ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            <Trans>Show more</Trans>
          </Button>
        ) : null}
        {adding ? (
          <form
            className={`flex items-center gap-2 ${items.length ? "mt-2" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              void addItem();
            }}
          >
            <Input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t`Add item`}
              aria-label={t`New open-work item`}
              maxLength={200}
              className="min-w-0 flex-1"
            />
            <Button
              variant="secondary"
              disabled={busy || !draft.trim()}
              onClick={() => void addItem()}
            >
              <Trans>Add</Trans>
            </Button>
          </form>
        ) : null}
      </div>
      {error ? <div className="mt-2 text-body-sm text-destructive">{error}</div> : null}
    </div>
  );
}
