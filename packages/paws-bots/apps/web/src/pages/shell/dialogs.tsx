import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { AccountItem, Bot, BotSection } from "@rakazo/contracts";
import { botRemovalWarning } from "@rakazo/i18n/bot-removal";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  RadioGroup,
  RadioGroupItem,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useSpaceQueries } from "../../lib/query";
import { errorText } from "../../lib/user-error";

/** Each dialog is mounted only while open, so `open` is always true and the
 * parent unmounts it from `onCancel`. Escape and backdrop presses are ignored
 * while a request is in flight. */
function closeUnlessBusy(busy: boolean, onCancel: () => void) {
  return (open: boolean) => {
    if (!open && !busy) onCancel();
  };
}

export function NewSpaceDialog({
  onCancel,
  onCreate,
  loadItems,
  chooseItems,
  onDone,
}: {
  onCancel: () => void;
  onCreate: (name: string) => Promise<string>;
  /** The user's own skills, servers, plugins and tool sources, across their spaces. */
  loadItems: () => Promise<AccountItem[]>;
  chooseItems: (spaceId: string, items: AccountItem[]) => Promise<void>;
  onDone: (spaceId: string) => void;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; items: AccountItem[] } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const key = (item: AccountItem) => `${item.kind}:${item.id}`;

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    void (async () => {
      let spaceId: string;
      try {
        spaceId = await onCreate(trimmed);
      } catch (reason) {
        setError(errorText(reason, t`Could not create space`));
        setSaving(false);
        return;
      }
      // Without items of their own there is nothing to choose, so the space is ready.
      const items = await loadItems().catch(() => []);
      if (!items.length) return onDone(spaceId);
      setChosen(new Set(items.filter((item) => item.availability.allSpaces).map(key)));
      setCreated({ id: spaceId, items });
      setSaving(false);
    })();
  };

  const finish = () => {
    if (!created || saving) return;
    setSaving(true);
    setError(null);
    void chooseItems(
      created.id,
      created.items.filter((item) => chosen.has(key(item))),
    )
      .then(() => onDone(created.id))
      .catch((reason: unknown) => {
        setError(errorText(reason, t`Could not save`));
        setSaving(false);
      });
  };

  if (created)
    return (
      <Dialog open onOpenChange={closeUnlessBusy(true, onCancel)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              <Trans>What can this space use?</Trans>
            </DialogTitle>
          </DialogHeader>
          <div data-testid="new-space-items" className="max-h-80 space-y-1 overflow-y-auto">
            {created.items.map((item) => (
              <div
                key={key(item)}
                className="flex items-center gap-3 rounded-lg px-1 py-1.5 text-body text-foreground"
              >
                <Checkbox
                  id={`new-space-item-${key(item)}`}
                  checked={chosen.has(key(item))}
                  onCheckedChange={(checked) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (checked) next.add(key(item));
                      else next.delete(key(item));
                      return next;
                    })
                  }
                />
                <label htmlFor={`new-space-item-${key(item)}`} className="min-w-0 flex-1 truncate">
                  {item.name}
                </label>
              </div>
            ))}
          </div>
          {error ? <p className="text-body text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button disabled={saving} onClick={finish}>
              {saving ? <Trans>Saving…</Trans> : <Trans>Continue</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

  return (
    <Dialog open onOpenChange={closeUnlessBusy(saving, onCancel)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <Lock
              size={17}
              strokeWidth={1.8}
              className="text-muted-foreground"
              aria-hidden="true"
            />
            <Trans>New space</Trans>
          </DialogTitle>
        </DialogHeader>
        <label htmlFor={nameId} className="block text-body text-foreground/75">
          <Trans>Name</Trans>
          <Input
            id={nameId}
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                if (event.key === "Escape") event.stopPropagation();
                return;
              }
              if (event.key === "Enter") create();
            }}
            placeholder={t`Customer support`}
            className="mt-2"
          />
        </label>
        {error ? <p className="text-body text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={saving || !name.trim()} onClick={create}>
            {saving ? <Trans>Creating…</Trans> : <Trans>Create space</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NewBotSectionDialog({
  bot,
  onCancel,
  onConfirm,
}: {
  bot: Pick<Bot, "name">;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open onOpenChange={closeUnlessBusy(saving, onCancel)}>
      <DialogContent showCloseButton={false}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed || saving) return;
            setSaving(true);
            setError(null);
            void onConfirm(trimmed).catch((err: unknown) => {
              setError(errorText(err, t`Could not create section`));
              setSaving(false);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>New section</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Create a section and move {bot.name} into it.</Trans>
            </DialogDescription>
          </DialogHeader>
          <label htmlFor={nameId} className="block text-body text-foreground/75">
            <Trans>Name</Trans>
            <Input
              id={nameId}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-2"
            />
          </label>
          {error ? <p className="text-body text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameBotSectionDialog({
  section,
  onCancel,
  onConfirm,
}: {
  section: Pick<BotSection, "name">;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState(section.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const unchanged = trimmed === section.name;

  return (
    <Dialog open onOpenChange={closeUnlessBusy(saving, onCancel)}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed || saving || unchanged) return;
            setSaving(true);
            setError(null);
            void onConfirm(trimmed).catch((err: unknown) => {
              setError(errorText(err, t`Could not rename section`));
              setSaving(false);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Rename section</Trans>
            </DialogTitle>
          </DialogHeader>
          <label htmlFor={nameId} className="block text-body text-foreground/75">
            <Trans>Name</Trans>
            <Input
              id={nameId}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-2"
              autoFocus
            />
          </label>
          {error ? <p className="text-body text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={saving || !trimmed || unchanged}>
              {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ClearConversationDialog({
  bot,
  onCancel,
  onConfirm,
}: {
  bot: Pick<Bot, "name">;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <ConfirmDialog
      onCancel={onCancel}
      title={<Trans>Clear {bot.name}’s conversation?</Trans>}
      description={
        <Trans>
          This permanently removes every message and stops current work. The chat remains available.
        </Trans>
      }
      error={error}
      busy={clearing}
      onConfirm={() => {
        setClearing(true);
        setError(null);
        void onConfirm().catch((err: unknown) => {
          setError(errorText(err, t`Could not clear conversation`));
          setClearing(false);
        });
      }}
      confirmLabel={clearing ? <Trans>Clearing…</Trans> : <Trans>Clear</Trans>}
    />
  );
}

/** The groups a failed preview cannot name, so Delete stays available. */
function removedGroupsWarning(input: { failed: boolean; groups: readonly { name: string }[] }) {
  const warning = botRemovalWarning(input.failed ? null : input.groups);
  return warning ? <> {warning}</> : null;
}

export function DeleteBotDialog({
  bot,
  onCancel,
  onConfirm,
}: {
  bot: Pick<Bot, "id" | "name">;
  onCancel: () => void;
  onConfirm: (deleteMemories: boolean) => Promise<void>;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [deleting, setDeleting] = useState(false);
  const [deleteMemories, setDeleteMemories] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memoriesLabelId = useId();
  // A failed read must not keep Delete disabled.
  const preview = useQuery({
    ...queries.bots.removePreview.queryOptions({ input: { botId: bot.id } }),
    retry: false,
  });
  const groupWarning = removedGroupsWarning({
    failed: preview.isError && !preview.isFetching,
    groups: preview.data ?? [],
  });

  return (
    <ConfirmDialog
      onCancel={onCancel}
      title={<Trans>Delete {bot.name}?</Trans>}
      description={
        <>
          <Trans>
            Its conversation, files, and routines will be permanently deleted. Bots it created stay
            in your list.
          </Trans>
          {groupWarning}
        </>
      }
      error={error}
      busy={deleting}
      confirmDisabled={preview.isPending || preview.isFetching}
      onConfirm={() => {
        setDeleting(true);
        setError(null);
        void onConfirm(deleteMemories).catch((err: unknown) => {
          setError(errorText(err, t`Could not delete bot`));
          setDeleting(false);
        });
      }}
      confirmLabel={deleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
    >
      <div className="space-y-2">
        <p id={memoriesLabelId} className="mb-2 text-body text-foreground/75">
          <Trans>What about its memories?</Trans>
        </p>
        <RadioGroup
          aria-labelledby={memoriesLabelId}
          value={deleteMemories ? "delete" : "keep"}
          onValueChange={(value) => setDeleteMemories(value === "delete")}
        >
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the wrapped RadioGroupItem is the control. */}
          <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3">
            <RadioGroupItem value="keep" className="mt-0.5" />
            <span>
              <span className="block text-body text-foreground">
                <Trans>Keep memories</Trans>
              </span>
              <span className="mt-0.5 block text-body-sm text-muted-foreground">
                <Trans>Move them to your shared memory.</Trans>
              </span>
            </span>
          </label>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the wrapped RadioGroupItem is the control. */}
          <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3">
            <RadioGroupItem value="delete" className="mt-0.5" />
            <span>
              <span className="block text-body text-foreground">
                <Trans>Delete memories too</Trans>
              </span>
              <span className="mt-0.5 block text-body-sm text-muted-foreground">
                <Trans>This cannot be undone.</Trans>
              </span>
            </span>
          </label>
        </RadioGroup>
      </div>
    </ConfirmDialog>
  );
}

/** The space the Space settings section acts on. */
export type SettingsSpace = {
  id: string;
  name: string;
  canRename?: boolean;
  canDelete?: boolean;
  /** Every bot deleting the space removes, from the server. */
  botCount?: number;
};
/** Names what goes with the space: its bots, and with them their chats and groups. */
export function DeleteSpaceDialog({
  space,
  onCancel,
  onConfirm,
}: {
  space: SettingsSpace;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const botCount = space.botCount ?? 0;
  const name = space.name;
  return (
    <DeleteItemDialog
      item={space}
      noun="space"
      title={
        botCount > 0 ? (
          <Plural
            value={botCount}
            one={`Delete ${name} and its # bot?`}
            other={`Delete ${name} and its # bots?`}
          />
        ) : undefined
      }
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function DeleteItemDialog({
  item,
  noun,
  title,
  description,
  onCancel,
  onConfirm,
}: {
  item: { name: string };
  noun: "group" | "page" | "routine" | "section" | "space";
  title?: React.ReactNode;
  description?: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <ConfirmDialog
      onCancel={onCancel}
      title={title ?? <Trans>Delete {item.name}?</Trans>}
      description={description ?? <Trans>This cannot be undone.</Trans>}
      error={error}
      busy={deleting}
      onConfirm={() => {
        setDeleting(true);
        setError(null);
        void onConfirm().catch((err: unknown) => {
          setError(
            errorText(
              err,
              noun === "group"
                ? t`Could not delete group`
                : noun === "space"
                  ? t`Could not delete space`
                  : noun === "section"
                    ? t`Could not delete section`
                    : noun === "page"
                      ? t`Could not delete page`
                      : t`Could not delete routine`,
            ),
          );
          setDeleting(false);
        });
      }}
      confirmLabel={deleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
    />
  );
}
