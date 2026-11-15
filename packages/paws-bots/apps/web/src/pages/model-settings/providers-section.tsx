import { Trans, useLingui } from "@lingui/react/macro";
import { MAX_MODEL_CONNECTION_LABEL } from "@rakazo/contracts";
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  Input,
  ListSearchInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SectionHeading,
} from "@rakazo/ui-web";
import { ChevronRight, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useRef, useState } from "react";
import type { ModelCredential } from "../../lib/model-auth";
import { useSpaceRpc } from "../../lib/space-rpc";
import { useListSearch } from "../../lib/use-list-search";
import { errorText } from "../../lib/user-error";
import type { ConnectableProvider } from "./role-model-picker";

/** Every connection the member has, with the way to add another, even for a connected provider. */
export function ProvidersSection({
  credentials,
  providers,
  name: nameOf,
  disabled,
  onAdd,
  onOpen,
  panel,
  panelAt,
}: {
  credentials: ModelCredential[];
  /** Every provider that can be connected, connected ones included. */
  providers: ConnectableProvider[];
  /** A connection's name, such as "OpenAI" or "OpenAI (Work)". */
  name: (credential: ModelCredential) => string;
  disabled?: boolean;
  onAdd: (provider: ConnectableProvider) => void;
  onOpen: (credential: ModelCredential) => void;
  /** The connection form, shown under the connection it belongs to or after the list. */
  panel?: ReactNode;
  /** The connection id the form belongs to, or "add" for a new one. */
  panelAt?: string | null;
}) {
  return (
    <section className="mb-8" data-testid="model-providers">
      <SectionHeading className="mb-2.5">
        <Trans>Providers</Trans>
      </SectionHeading>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {[...credentials]
          // Saving a key reorders the account's connections; this list stays put.
          .sort((left, right) => nameOf(left).localeCompare(nameOf(right)))
          .map((credential) => (
            <li key={credential.id} data-testid={`model-provider-${credential.id}`}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onOpen(credential)}
                className="flex min-h-[52px] w-full items-center gap-2.5 py-2 ps-3 pe-3 text-start outline-none first:rounded-t-xl hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="min-w-0 flex-1 truncate text-body-lg text-foreground">
                  {nameOf(credential)}
                </span>
                {credential.reconnectRequired ? (
                  <span className="shrink-0 text-body-sm text-warning">
                    <Trans>Sign in again</Trans>
                  </span>
                ) : null}
                <ChevronRight
                  className={`size-4 shrink-0 text-muted-foreground transition-transform ${panelAt === credential.id ? "rotate-90" : ""}`}
                  aria-hidden
                />
              </button>
              {panelAt === credential.id ? <div className="px-3 pb-3">{panel}</div> : null}
            </li>
          ))}
        <li>
          <AddProvider providers={providers} disabled={disabled} onPick={onAdd} />
        </li>
      </ul>
      {panelAt === "add" ? panel : null}
    </section>
  );
}

/** A connection's editable name, saved on its own. */
export function ConnectionNameField({
  credential,
  onRenamed,
}: {
  credential: ModelCredential;
  onRenamed: () => void;
}) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState(credential.label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  return (
    <form
      className="mb-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmed || saving || trimmed === credential.label) return;
        setSaving(true);
        setError(null);
        rpc.models
          .rename({ credentialId: credential.id, label: trimmed })
          .then(onRenamed, (err: unknown) =>
            setError(errorText(err, t`Could not rename connection`)),
          )
          .finally(() => setSaving(false));
      }}
    >
      <label htmlFor={nameId} className="block text-body text-muted-foreground">
        <Trans>Name</Trans>
      </label>
      <div className="mt-2 flex gap-2">
        <Input
          id={nameId}
          maxLength={MAX_MODEL_CONNECTION_LABEL}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-10 text-foreground"
        />
        {trimmed && trimmed !== credential.label ? (
          <Button type="submit" variant="secondary" className="h-10" disabled={saving}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-body text-destructive">{error}</p> : null}
    </form>
  );
}

function AddProvider({
  providers,
  disabled,
  onPick,
}: {
  providers: ConnectableProvider[];
  disabled?: boolean;
  onPick: (provider: ConnectableProvider) => void;
}) {
  const { t } = useLingui();
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const {
    query,
    setQuery,
    showSearch,
    visible: matching,
  } = useListSearch(providers, { text: (provider) => provider.name });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setQuery("");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-b-xl px-3 py-3 text-start text-body text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Plus className="size-4" aria-hidden />
            <Trans>Add provider</Trans>
          </button>
        }
      />
      <PopoverContent
        align="start"
        sideOffset={6}
        initialFocus={showSearch ? searchRef : undefined}
        className="w-[min(360px,var(--available-width))] gap-0 overflow-hidden p-0 motion-reduce:animate-none"
      >
        <Command
          tabIndex={showSearch ? undefined : 0}
          label={t`Add provider`}
          shouldFilter={false}
          loop
        >
          {showSearch ? (
            <ListSearchInput
              command
              inputRef={searchRef}
              query={query}
              setQuery={setQuery}
              label={t`Add provider`}
              placeholder={t`Search`}
            />
          ) : null}
          <CommandList className="rk-scroll max-h-80">
            <CommandEmpty>
              <Trans>No results</Trans>
            </CommandEmpty>
            <CommandGroup>
              {matching.map((provider) => (
                <CommandItem
                  key={`${provider.id}:${provider.baseUrl ?? ""}`}
                  value={`${provider.id}:${provider.baseUrl ?? ""}`}
                  onSelect={() => {
                    setOpen(false);
                    onPick(provider);
                  }}
                >
                  <span className="min-w-0 truncate">{provider.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
