import { listenWindow } from "../paws/runtime";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@rakazo/contracts";
import { GROUP_MEMBER_MAX, GROUP_MEMBER_MIN, GROUP_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { BotAvatar, Button, Checkbox, Input, SectionHeading } from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorText } from "../lib/user-error";
import { DeleteItemDialog } from "./shell/dialogs";

function validSelection(name: string, selected: readonly string[]) {
  return (
    Boolean(name.trim()) &&
    selected.length >= GROUP_MEMBER_MIN &&
    selected.length <= GROUP_MEMBER_MAX
  );
}

function sameMembers(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function MemberPicker({
  bots,
  selected,
  onChange,
  onOpenBot,
  initiallyExpanded = false,
}: {
  bots: Bot[];
  selected: string[];
  onChange: (selected: string[]) => void;
  onOpenBot?: (botId: string) => void;
  initiallyExpanded?: boolean;
}) {
  const { t } = useLingui();
  const listId = useId();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [query, setQuery] = useState("");
  // Every bot ever picked this session stays listed when collapsed, so an
  // unchecked member remains re-checkable until the form is saved.
  const [everPicked, setEverPicked] = useState<ReadonlySet<string>>(() => new Set(selected));
  const selectable = useMemo(() => bots.filter((bot) => !bot.archivedAt), [bots]);
  // The filter field only exists in the expanded view; never let a stale
  // query hide members when the list is collapsed.
  const needle = expanded ? query.trim().toLowerCase() : "";
  const visible = useMemo(() => {
    const base = expanded ? selectable : selectable.filter((bot) => everPicked.has(bot.id));
    if (!needle) return base;
    return base.filter((bot) => bot.name.toLowerCase().includes(needle));
  }, [expanded, selectable, everPicked, needle]);

  function toggle(botId: string) {
    if (selected.includes(botId)) {
      onChange(selected.filter((id) => id !== botId));
    } else if (selected.length < GROUP_MEMBER_MAX) {
      setEverPicked((current) => new Set(current).add(botId));
      onChange([...selected, botId]);
    }
  }

  return (
    <div className="mt-5 flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between">
        <span className="text-body text-muted-foreground">
          <Trans>Members ({selected.length})</Trans>
        </span>
        <Button
          variant="text"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
          className="font-normal"
        >
          {expanded ? <Trans>Show selected</Trans> : <Trans>Show all</Trans>}
        </Button>
      </div>
      {expanded ? (
        <>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Filter bots`}
            aria-label={t`Filter bots`}
            className="mt-2"
          />
          <p className="mt-2 text-body text-muted-foreground">
            <Trans>
              Pick {GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX}
            </Trans>
          </p>
        </>
      ) : null}
      <div id={listId} className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
        {visible.map((bot) => {
          const checked = selected.includes(bot.id);
          return (
            <div
              key={bot.id}
              className={`flex w-full items-center rounded-xl px-2.5 py-2.5 ${
                checked ? "bg-accent" : "hover:bg-accent"
              }`}
            >
              <button
                type="button"
                onClick={() => onOpenBot?.(bot.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-start"
              >
                <BotAvatar
                  avatarSet={bot.avatarSet}
                  color={bot.color}
                  identity={bot.id}
                  size={32}
                  status={bot.status}
                />
                <span className="flex-1 text-body-lg text-foreground" dir="auto">
                  {bot.name}
                </span>
              </button>
              <Checkbox
                checked={checked}
                aria-label={
                  checked ? t`Remove ${bot.name} from the group` : t`Add ${bot.name} to the group`
                }
                onCheckedChange={() => toggle(bot.id)}
              />
            </div>
          );
        })}
        {visible.length === 0 ? (
          <p className="px-2.5 py-2.5 text-body text-muted-foreground">
            {expanded ? <Trans>No bots match</Trans> : <Trans>No members yet</Trans>}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function CreateGroupForm({
  bots,
  onCancel,
  onCreate,
  onOpenBot,
}: {
  bots: Bot[];
  onCancel: () => void;
  onCreate: (input: { name: string; botIds: string[] }) => Promise<void>;
  onOpenBot?: (botId: string) => void;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (submitting || !validSelection(name, selected)) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), botIds: selected });
    } catch (cause) {
      setError(errorText(cause, t`Could not create group`));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-body text-muted-foreground">
          <Trans>New group</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Cancel new group`}
          onClick={onCancel}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-body text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-body text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Name this group`}
          maxLength={GROUP_NAME_MAX_LENGTH}
          className="mt-2"
        />
      </label>
      <MemberPicker
        bots={bots}
        selected={selected}
        onChange={setSelected}
        onOpenBot={onOpenBot}
        initiallyExpanded
      />
      <Button
        className="mt-5 w-full"
        disabled={submitting || !validSelection(name, selected)}
        onClick={() => void create()}
      >
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create group</Trans>}
      </Button>
    </div>
  );
}

export function GroupSettings({
  group,
  bots,
  onSave,
  onRemove,
  onClose,
  onOpenBot,
  covered = false,
  pages,
}: {
  group: Group;
  bots: Bot[];
  onSave: (input: { name?: string; botIds?: string[] }) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
  onOpenBot?: (botId: string) => void;
  /** A full-screen overlay is on top, so Escape belongs to it. */
  covered?: boolean;
  pages?: ReactNode;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState(group.name);
  const [selected, setSelected] = useState(group.members.map((member) => member.botId));
  // The panel can open on a cached group. A refreshed one replaces whatever was not edited, so a
  // save does not send the cached name or members back as a change.
  const [shownGroup, setShownGroup] = useState(group);
  if (group !== shownGroup) {
    setShownGroup(group);
    if (name === shownGroup.name) setName(group.name);
    const shownMembers = shownGroup.members.map((member) => member.botId);
    if (sameMembers(selected, shownMembers)) {
      setSelected(group.members.map((member) => member.botId));
    }
  }
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Closing while a save is in flight would let its completion close the panel
  // again after a reopen. While the delete confirmation or an overlay is open,
  // Escape belongs to it.
  useEffect(() => {
    if (saving || confirmingDelete || covered) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        onClose();
      }
    };
    listenWindow("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, confirmingDelete, covered, onClose]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim() !== group.name ? name.trim() : undefined,
        botIds: sameMembers(
          selected,
          group.members.map((member) => member.botId),
        )
          ? undefined
          : selected,
      });
    } catch (cause) {
      setError(errorText(cause, t`Could not save group`));
      return;
    } finally {
      setSaving(false);
    }
    // A save that finishes after the user switched chats must not close
    // whatever panel is open there.
    if (mounted.current) onClose();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-body text-muted-foreground">
          <Trans>Group settings</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Close panel`}
          disabled={saving}
          onClick={onClose}
        >
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-body text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-body text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={GROUP_NAME_MAX_LENGTH}
          className="mt-2"
        />
      </label>
      <MemberPicker bots={bots} selected={selected} onChange={setSelected} onOpenBot={onOpenBot} />
      <Button
        className="mt-5 w-full"
        disabled={saving || !validSelection(name, selected)}
        onClick={() => void save()}
      >
        {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
      </Button>
      {pages ? (
        <section className="mt-6">
          <SectionHeading variant="label" className="mb-2">
            <Trans>Pages</Trans>
          </SectionHeading>
          {pages}
        </section>
      ) : null}
      <Button
        variant="destructive"
        className="mt-4 w-full"
        disabled={saving}
        onClick={() => setConfirmingDelete(true)}
      >
        <Trans>Delete group</Trans>
      </Button>
      {confirmingDelete ? (
        <DeleteItemDialog
          item={group}
          noun="group"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={onRemove}
        />
      ) : null}
    </div>
  );
}
