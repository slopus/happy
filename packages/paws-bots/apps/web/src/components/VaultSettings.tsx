import { Trans, useLingui } from "@lingui/react/macro";
import type {
  BotSecretMetadata,
  SettingsScope,
  VaultCsv,
  VaultKind,
  VaultRevealed,
} from "@rakazo/contracts";
import {
  isIdentityConfirmationRequired,
  parseVaultCsv,
  VAULT_IMPORT_FILE_LIMIT,
  VAULT_KINDS,
  vaultKind,
} from "@rakazo/contracts";
import { vaultBotsChoosable } from "@rakazo/core";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { vaultBotsNote, vaultSaveNotice } from "@rakazo/i18n/vault";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ListSearchInput,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileUp, Plus } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorCode, errorText } from "../lib/user-error";
import { useIdentityConfirmation } from "./ConfirmIdentityDialog";
import { useOwnSpaces } from "./integrations/space-availability";
import { BotEmailAddresses } from "./vault/BotEmailAddresses";
import { useVaultKindLabels, useVaultSubtitle, VaultTile } from "./vault/kinds";
import { VaultImportPage } from "./vault/VaultImport";
import { VaultItemDetail } from "./vault/VaultItemDetail";
import type { VaultEditorInitial, VaultEditorResult } from "./vault/VaultItemEditor";
import { VaultItemEditorPage } from "./vault/VaultItemEditor";

export { REVEAL_MS } from "./vault/VaultItemDetail";

/** Filters and search appear only once a vault holds enough to need them. */
const SEARCH_FROM = 8;
const REVEAL_CANCELLED = new Error("Reveal cancelled");

type Editing = { kind: VaultKind; mode: "new" | "edit"; initial?: VaultEditorInitial };

/** The items in the account's vault, or in the bound Space's own once it customizes them. */
export function VaultSettings({
  scope,
  onBusyChange,
}: {
  scope: SettingsScope;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.vault.list.queryOptions({ input: { scope } });
  const listQuery = useQuery({ ...list, refetchOnMount: "always" });
  // Bots are chosen in the Space they're in, and a Space with its own vault never uses the
  // account's.
  const overrides = useQuery({
    ...queries.spaceSettings.overrides.queryOptions(),
    enabled: scope === "account",
  });
  const otherSpaces = useOwnSpaces().length > 1;
  const ownVault = scope === "account" && Boolean(overrides.data?.includes("credentials"));
  // Until that's known, an account item offers no bots, so no choice is saved the Space can't use.
  const noBots = ownVault || (scope === "account" && !overrides.isSuccess);
  const botsNote = vaultBotsNote({
    ownVault,
    otherSpaces: scope === "account" && !noBots && otherSpaces,
  });
  const items = listQuery.data;
  const { one, many } = useVaultKindLabels();
  const subtitle = useVaultSubtitle();
  const [filter, setFilter] = useState<VaultKind | "all">("all");
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const revealAttempt = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState<{ read: number; csv: VaultCsv } | null>(null);
  // Counts file picks: only the last one's read is shown, whichever finishes first.
  const reads = useRef(0);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  async function refresh() {
    try {
      await fetchFresh(queryClient, list);
      return true;
    } catch {
      return false;
    }
  }

  const activityKey = (name: string) => queries.vault.activity.queryKey({ input: { scope, name } });

  async function save(result: VaultEditorResult) {
    setBusy(true);
    let saved: BotSecretMetadata;
    const input = {
      scope,
      destination: result.destination,
      ...(result.value !== undefined ? { value: result.value } : {}),
      ...(result.title !== undefined ? { title: result.title } : {}),
      ...(result.note !== undefined ? { note: result.note } : {}),
      ...(result.allBots !== undefined ? { allBots: result.allBots } : {}),
      ...(result.botIds ? { botIds: result.botIds } : {}),
      ...(result.policy ? { policy: result.policy } : {}),
      ...(result.alsoOn ? { alsoOn: result.alsoOn } : {}),
    };
    try {
      saved = await rpc.vault.put(input);
    } finally {
      setBusy(false);
    }
    void queryClient.invalidateQueries({ queryKey: activityKey(saved.name) });
    const fresh = await refresh();
    setError(fresh ? null : t`Could not load credentials.`);
    // An older server drops what it doesn't know silently, but the item is saved, so say what.
    const notice = vaultSaveNotice(result, saved);
    // Which bots may use it is shown as saved even when the list can't be read again, so it never
    // reads as blocked once bots can use it, and an item opened with a notice is there.
    if (!fresh && (result.policy || result.allBots !== undefined || notice))
      await writeSaved(queryClient, list.queryKey, (prev = []) => [
        ...prev.filter((row) => row.name !== saved.name),
        saved,
      ]);
    if (notice) {
      setOpened(saved.name);
      setDetailError(notice);
    }
  }

  // Read on this device: the export file itself is never uploaded.
  async function readExport(file: File | undefined) {
    if (!file) return;
    const read = ++reads.current;
    // A file that can't be read, such as one deleted since it was picked, says so.
    const text =
      file.size > VAULT_IMPORT_FILE_LIMIT ? undefined : await file.text().catch(() => undefined);
    const csv: VaultCsv =
      text !== undefined
        ? parseVaultCsv(text)
        : { error: file.size > VAULT_IMPORT_FILE_LIMIT ? "too_large" : "unreadable" };
    if (read === reads.current) setImporting({ read, csv });
  }

  async function importRows(rows: Parameters<typeof rpc.vault.import>[0]["rows"]) {
    setBusy(true);
    try {
      return await rpc.vault.import({ scope, rows });
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function reveal(name: string): Promise<VaultRevealed | null> {
    setDetailError(null);
    const attempt = revealAttempt.current;
    const current = () => revealAttempt.current === attempt;
    try {
      const shown = await withIdentityConfirmation(async () => {
        try {
          return await rpc.vault.reveal({ scope, name });
        } catch (err) {
          // A reveal whose item closed while it waited must not ask the person to confirm.
          throw current() ? err : REVEAL_CANCELLED;
        }
      });
      return current() ? shown : null;
    } catch (err) {
      // Closing the confirmation is a choice, not a failure.
      if (current() && err !== REVEAL_CANCELLED && !isIdentityConfirmationRequired(err))
        setDetailError(errorText(err, t`Could not show the credential`));
      return null;
    }
  }

  /** Leaves the opened item; a reveal still waiting for it is dropped. */
  function closeItem() {
    revealAttempt.current += 1;
    setOpened(null);
  }

  async function remove(name: string) {
    if (busy) return false;
    setDetailError(null);
    setBusy(true);
    try {
      await rpc.vault.remove({ scope, name });
    } catch (err) {
      setDetailError(errorText(err, t`Could not remove the credential`));
      return false;
    } finally {
      setBusy(false);
    }
    // The name can be saved again at once, and a new item must not show this one's uses.
    queryClient.removeQueries({ queryKey: activityKey(name) });
    closeItem();
    if (!(await refresh())) {
      await writeSaved(queryClient, list.queryKey, (prev = []) =>
        prev.filter((row) => row.name !== name),
      );
      setError(t`Could not load credentials.`);
    }
    return true;
  }

  function startEdit(item: BotSecretMetadata, revealed?: VaultRevealed) {
    if (!item.auth) return;
    const kind = vaultKind(item.auth.type);
    // The item stays opened underneath, so saving or going back returns to it.
    setEditing({
      kind,
      mode: "edit",
      initial: {
        name: item.name,
        title: item.title,
        note: item.note,
        origin: item.origin,
        auth: item.auth,
        ...(revealed && "fields" in revealed
          ? { loginFields: revealed.fields, otp: revealed.otp }
          : {}),
        ...(revealed && "card" in revealed ? { card: revealed.card } : {}),
        ...(item.preview?.contact ? { contact: item.preview.contact } : {}),
        ...(item.policy ? { policy: item.policy } : {}),
        ...(item.allBots !== undefined
          ? { access: { allBots: item.allBots, botIds: item.botIds ?? [] } }
          : {}),
        ...(item.alsoOn ? { alsoOn: item.alsoOn } : {}),
      },
    });
  }

  // A new item can be limited to chosen bots unless the saved ones show this server can't.
  const newItem = (kind: VaultKind): Editing => ({
    kind,
    mode: "new",
    ...(vaultBotsChoosable(items) ? { initial: { access: { allBots: true, botIds: [] } } } : {}),
  });

  const contacts = (items ?? []).flatMap((item) =>
    item.auth?.type === "contact" ? [{ name: item.name, title: item.title }] : [],
  );
  const counts = new Map<VaultKind, number>();
  for (const item of items ?? [])
    if (item.auth)
      counts.set(vaultKind(item.auth.type), (counts.get(vaultKind(item.auth.type)) ?? 0) + 1);
  const kindsShown = VAULT_KINDS.filter((kind) => counts.has(kind));
  const activeFilter = filter !== "all" && counts.has(filter) ? filter : "all";
  const searching = (items?.length ?? 0) >= SEARCH_FROM;
  const needle = searching ? search.trim().toLowerCase() : "";
  const shown = (items ?? []).filter(
    (item) =>
      (activeFilter === "all" || (item.auth && vaultKind(item.auth.type) === activeFilter)) &&
      (!needle ||
        [item.title, subtitle(item), item.origin, item.name].some((text) =>
          text.toLowerCase().includes(needle),
        )),
  );
  const openedItem = items?.find((item) => item.name === opened);

  // Bots are offered once it's known this Space can use them, even in an editor already open.
  const editingInitial = editing?.initial && {
    ...editing.initial,
    access: noBots ? undefined : editing.initial.access,
    ...(editing.initial.access ? { botsNote } : {}),
  };
  // An item or form takes the list's place in this panel instead of opening a dialog over Settings.
  if (editing)
    return (
      <section data-testid="vault">
        <VaultItemEditorPage
          key={`${editing.mode}-${editing.kind}-${editing.initial?.name ?? ""}`}
          onBack={() => setEditing(null)}
          kind={editing.kind}
          mode={editing.mode}
          heading={
            editing.mode === "edit"
              ? (editing.initial?.title ?? one[editing.kind])
              : {
                  login: t`New login`,
                  card: t`New card`,
                  contact: t`New contact`,
                  api_key: t`New API key`,
                  variable: t`New variable`,
                }[editing.kind]
          }
          initial={editingInitial}
          contacts={contacts}
          onSave={save}
          failureText={(err) => errorText(err, t`Could not save the credential`)}
        />
      </section>
    );
  if (importing)
    return (
      <section data-testid="vault">
        <VaultImportPage
          // A new file starts a new review, with its own plan.
          key={importing.read}
          csv={importing.csv}
          saved={items ?? []}
          onImport={importRows}
          failureText={(err) =>
            // A server from before import has no such call.
            errorCode(err) === "NOT_FOUND"
              ? t`Update your server to import logins.`
              : // On two lines: joining the two would need punctuation each language writes its way.
                `${errorText(err, t`Could not import`)}\n${t`Some logins may have been saved. Importing the file again skips them.`}`
          }
          onBack={() => {
            reads.current += 1;
            setImporting(null);
          }}
        />
      </section>
    );
  if (openedItem)
    return (
      <section data-testid="vault">
        <VaultItemDetail
          key={openedItem.name}
          scope={scope}
          ownVault={ownVault}
          item={openedItem}
          contactTitles={new Map(contacts.map((contact) => [contact.name, contact.title]))}
          busy={busy}
          error={detailError}
          onClose={closeItem}
          onReveal={() => reveal(openedItem.name)}
          onEdit={(revealed) => startEdit(openedItem, revealed)}
          onRemove={() => remove(openedItem.name)}
        />
        {identityDialog}
      </section>
    );

  return (
    <section data-testid="vault" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {kindsShown.length > 1 ? (
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0" aria-label={t`Show`}>
            {(["all", ...kindsShown] as const).map((kind) => (
              <Button
                key={kind}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={activeFilter === kind}
                data-testid={`vault-filter-${kind}`}
                className="rounded-full text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
                onClick={() => setFilter(kind)}
              >
                {kind === "all" ? t`All` : many[kind]}
                <span className="text-faint-foreground tabular-nums">
                  {kind === "all" ? items?.length : counts.get(kind)}
                </span>
              </Button>
            ))}
          </fieldset>
        ) : null}
        <span className="flex-1" />
        {searching ? (
          <div className="w-44">
            <ListSearchInput
              query={search}
              setQuery={setSearch}
              label={t`Search Vault`}
              placeholder={t`Search`}
            />
          </div>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="vault-new"
            disabled={busy}
            render={<Button size="sm" className="rounded-full" />}
          >
            <Plus />
            <Trans>New</Trans>
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {VAULT_KINDS.map((kind) => (
              <Fragment key={kind}>
                {kind === "api_key" ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  data-testid={`vault-new-${kind}`}
                  onClick={() => setEditing(newItem(kind))}
                >
                  <VaultTile kind={kind} title="" className="size-5 rounded-none bg-transparent" />
                  {one[kind]}
                </DropdownMenuItem>
              </Fragment>
            ))}
            <DropdownMenuSeparator />
            {/* A review plans against the Vault as read, so it waits for a good read. */}
            <DropdownMenuItem
              data-testid="vault-import"
              disabled={!listQuery.isSuccess}
              onClick={() => fileInput.current?.click()}
            >
              <FileUp className="text-muted-foreground" />
              <Trans>Import CSV</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          hidden
          data-testid="vault-import-file"
          onChange={(event) => {
            void readExport(event.target.files?.[0]);
            // The same file can be picked again after going back.
            event.target.value = "";
          }}
        />
      </div>
      {listQuery.isError ? (
        <p className="text-body-sm text-destructive">
          <Trans>Could not load credentials.</Trans>
        </p>
      ) : null}
      {shown.length ? (
        <ul data-testid="vault-card" className="overflow-hidden rounded-xl bg-muted/50">
          {shown.map((item) => {
            const kind = item.auth ? vaultKind(item.auth.type) : null;
            const line = item.auth ? subtitle(item) : "";
            return (
              <li key={item.name} className="border-t border-border first:border-t-0">
                <button
                  type="button"
                  data-testid="vault-credential-row"
                  data-name={item.name}
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-start hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={() => {
                    setDetailError(null);
                    setOpened(item.name);
                  }}
                >
                  <VaultTile kind={kind} title={item.title} origin={item.origin} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-foreground">
                      {item.title}
                    </span>
                    {item.auth ? (
                      line ? (
                        <span
                          className={`block truncate text-body-sm text-muted-foreground ${kind === "variable" ? "font-mono" : ""}`}
                        >
                          {line}
                        </span>
                      ) : null
                    ) : (
                      <span className="block truncate text-body-sm text-destructive">
                        <Trans>
                          These saved settings can't be read. Remove it and add it again.
                        </Trans>
                      </span>
                    )}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-faint-foreground rtl:rotate-180" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : needle && items?.length ? (
        <p className="py-6 text-center text-body-sm text-muted-foreground">
          <Trans>No matches</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      {scope === "account" ? <BotEmailAddresses /> : null}
      {identityDialog}
    </section>
  );
}
