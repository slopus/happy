import { Trans, useLingui } from "@lingui/react/macro";
import type { BotSecretMetadata, SettingsScope, VaultRevealed } from "@rakazo/contracts";
import {
  BotSecretName,
  cardExpiry,
  commandVariableName,
  hasVaultAccess,
  otherSitesText,
  vaultKind,
} from "@rakazo/contracts";
import { vaultBotsLine } from "@rakazo/i18n/vault";
import { Button } from "@rakazo/ui-web";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import type { VaultAuth } from "./kinds";
import { siteHost, useVaultKindLabels, VaultTile } from "./kinds";
import { useVaultBots } from "./VaultItemAccess";
import { VaultItemActivity, VaultItemUses } from "./VaultItemActivity";
import { VaultPageHeader } from "./VaultPageHeader";

/** How long a shown value stays on screen. */
export const REVEAL_MS = 30_000;

const MASK = "••••••••";

function CopyButton({ text }: { text: string }) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? t`Copied` : t`Copy`}
      className="shrink-0 text-muted-foreground"
      onClick={() => copy(text)}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}

/** One line of an item: its label, its value, and what can be done with the value. */
function DetailRow({
  label,
  children,
  copy,
  action,
  testId,
}: {
  label: string;
  children: ReactNode;
  copy?: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex min-h-11 items-center gap-3 border-t border-border py-2 first:border-t-0"
    >
      <span className="w-28 shrink-0 text-body-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 whitespace-pre-line break-words text-body">{children}</span>
      {action}
      {copy ? <CopyButton text={copy} /> : null}
    </div>
  );
}

function addressLines(contact: NonNullable<NonNullable<BotSecretMetadata["preview"]>["contact"]>) {
  const place = [contact.city, [contact.region, contact.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [contact.line1, contact.line2, place, contact.country].filter(Boolean).join("\n");
}

/**
 * One vault item, opened from the list in Settings' own panel: what it holds, with protected values masked until the
 * owner confirms it's them, and Edit and Remove.
 */
export function VaultItemDetail({
  scope,
  ownVault,
  item,
  contactTitles,
  busy,
  error,
  onClose,
  onReveal,
  onEdit,
  onRemove,
}: {
  scope: SettingsScope;
  /** An account item seen from a Space that keeps its own vault, whose bots never use it. */
  ownVault: boolean;
  item: BotSecretMetadata;
  /** Saved contacts' titles by name, for a card's billing address. */
  contactTitles: ReadonlyMap<string, string>;
  busy: boolean;
  error: string | null;
  /** Back to the list. */
  onClose: () => void;
  /** Resolves with the value, or null when the person didn't confirm. */
  onReveal: () => Promise<VaultRevealed | null>;
  /** Opens the editor; a login or card brings its revealed value to start from. */
  onEdit: (revealed?: VaultRevealed) => void;
  onRemove: () => Promise<boolean>;
}) {
  const { t } = useLingui();
  const { one } = useVaultKindLabels();
  const bots = useVaultBots(item.allBots === false && !ownVault, item.botIds);
  // An item saved under a name the current rules refuse can only be removed.
  const auth: VaultAuth | null =
    item.auth && BotSecretName.safeParse(item.name).success ? item.auth : null;
  const kind = auth ? vaultKind(auth.type) : null;
  const [revealed, setRevealed] = useState<VaultRevealed | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [usesOpen, setUsesOpen] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const attempt = useRef(0);

  useEffect(
    () => () => {
      attempt.current += 1;
      window.clearTimeout(hideTimer.current);
    },
    [],
  );

  function hide() {
    attempt.current += 1;
    window.clearTimeout(hideTimer.current);
    setRevealed(null);
    setRevealing(false);
  }

  async function reveal(): Promise<VaultRevealed | null> {
    const current = ++attempt.current;
    setRevealing(true);
    try {
      const shown = await onReveal();
      if (current !== attempt.current) return null;
      if (shown) {
        setRevealed(shown);
        window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(hide, REVEAL_MS);
      }
      return shown;
    } finally {
      if (current === attempt.current) setRevealing(false);
    }
  }

  async function edit() {
    if (kind === "login" || kind === "card") {
      const shown = revealed ?? (await reveal());
      if (!shown) return;
      hide();
      onEdit(shown);
    } else onEdit();
  }

  const showButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={revealed ? t`Hide` : t`Show`}
      data-testid="vault-item-show"
      className="shrink-0 text-muted-foreground"
      disabled={busy || revealing}
      onClick={() => (revealed ? hide() : void reveal())}
    >
      {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
    </Button>
  );

  const revealedValue = revealed && "value" in revealed ? revealed.value : undefined;
  const revealedCard = revealed && "card" in revealed ? revealed.card : undefined;
  const card = item.preview?.card;
  const contact = item.preview?.contact;

  const rows: ReactNode[] = [];
  if (auth && kind === "login") {
    rows.push(
      <DetailRow key="site" label={t`Site`} copy={item.origin}>
        {siteHost(item.origin)}
      </DetailRow>,
    );
    if (item.alsoOn?.length)
      rows.push(
        <DetailRow key="also-on" label={t`Also on`}>
          {otherSitesText(item.alsoOn)}
        </DetailRow>,
      );
    if (revealed && "fields" in revealed) {
      rows.push(
        ...revealed.fields.map((field, index) => (
          <DetailRow
            key={`field-${index}`}
            testId="vault-item-field"
            label={field.label}
            copy={field.value}
            action={index === 0 ? showButton : undefined}
          >
            <span className={field.hidden ? "font-mono text-body-sm" : undefined}>
              {field.value}
            </span>
          </DetailRow>
        )),
      );
    } else {
      if (item.preview?.username)
        rows.push(
          <DetailRow key="username" label={t`Username`} copy={item.preview.username}>
            {item.preview.username}
          </DetailRow>,
        );
      rows.push(
        <DetailRow key="password" label={t`Password`} action={showButton}>
          <span className="font-mono text-body-sm">{MASK}</span>
        </DetailRow>,
      );
    }
    // Shown and hidden with the password: the same reveal holds both.
    const otp = revealed && "fields" in revealed ? revealed.otp : undefined;
    if (item.preview?.otp || otp)
      rows.push(
        <DetailRow key="otp" label={t`Authenticator key`} copy={otp} testId="vault-item-otp">
          <span className="font-mono text-body-sm">{otp ?? MASK}</span>
        </DetailRow>,
      );
  }
  if (auth && kind === "card" && card) {
    const number = revealedCard?.number.replace(/(\d{4})(?=\d)/g, "$1 ");
    rows.push(
      <DetailRow
        key="number"
        label={t`Number`}
        copy={revealedCard?.number}
        action={showButton}
        testId="vault-item-card-number"
      >
        <span className="font-mono text-body-sm tabular-nums">
          {number ?? `•••• ${card.last4}`}
        </span>
      </DetailRow>,
      <DetailRow key="expiry" label={t`Expires`} copy={cardExpiry(card)}>
        {cardExpiry(card)}
      </DetailRow>,
      <DetailRow key="cvc" label={t`Security code`} copy={revealedCard?.cvc}>
        <span className="font-mono text-body-sm">
          {revealedCard ? (revealedCard.cvc ?? "") : "•••"}
        </span>
      </DetailRow>,
    );
    if (card.name)
      rows.push(
        <DetailRow key="name" label={t`Name on card`} copy={card.name}>
          {card.name}
        </DetailRow>,
      );
    // A billing contact removed since the card was saved shows as no billing address.
    const billingTitle = card.billing ? contactTitles.get(card.billing) : undefined;
    if (billingTitle)
      rows.push(
        <DetailRow key="billing" label={t`Billing address`}>
          {billingTitle}
        </DetailRow>,
      );
  }
  if (auth && kind === "contact" && contact) {
    const address = addressLines(contact);
    if (contact.name)
      rows.push(
        <DetailRow key="name" label={t`Full name`} copy={contact.name}>
          {contact.name}
        </DetailRow>,
      );
    if (address)
      rows.push(
        <DetailRow key="address" label={t`Address`} copy={address}>
          {address}
        </DetailRow>,
      );
    if (contact.phone)
      rows.push(
        <DetailRow key="phone" label={t`Phone`} copy={contact.phone}>
          {contact.phone}
        </DetailRow>,
      );
    if (contact.email)
      rows.push(
        <DetailRow key="email" label={t`Email`} copy={contact.email}>
          {contact.email}
        </DetailRow>,
      );
  }
  if (auth && (kind === "api_key" || kind === "variable")) {
    if (auth.type === "command") {
      const variable = `$${commandVariableName(item.name)}`;
      rows.push(
        <DetailRow key="variable" label={t`Variable`} copy={variable}>
          <span className="font-mono text-body-sm">{variable}</span>
        </DetailRow>,
      );
    } else {
      rows.push(
        <DetailRow key="site" label={t`Site`} copy={item.origin}>
          {item.origin}
        </DetailRow>,
      );
      const header = auth.type === "header" ? auth.name : "";
      const username = auth.type === "basic" ? auth.username : "";
      rows.push(
        <DetailRow key="type" label={t`Type`}>
          {auth.type === "header"
            ? t`Header "${header}"`
            : auth.type === "basic"
              ? t`Basic auth (${username})`
              : t`Bearer token`}
        </DetailRow>,
      );
    }
    rows.push(
      <DetailRow
        key="value"
        label={t`Value`}
        copy={revealedValue}
        action={showButton}
        testId="vault-item-value"
      >
        <span className="break-all font-mono text-body-sm">{revealedValue ?? MASK}</span>
      </DetailRow>,
    );
  }
  if (item.note)
    rows.push(
      <DetailRow key="note" label={t`When to use`}>
        {item.note}
      </DetailRow>,
    );
  // The bots it is limited to are named once the list has loaded, never as No bots before, nor as
  // every bot when it can't be read.
  const chosen = (bots ?? []).filter((bot) => item.botIds?.includes(bot.id)).map((bot) => bot.name);
  const access = kind
    ? vaultBotsLine({
        blockable: hasVaultAccess(kind),
        policy: item.policy,
        allBots: item.allBots,
        botIds: item.botIds,
        unusedHere: ownVault,
        chosen: bots === null ? "failed" : bots ? chosen : "loading",
      })
    : "";
  if (access)
    rows.push(
      <DetailRow key="access" label={t`Bots`} testId="vault-item-access-detail">
        {access}
      </DetailRow>,
    );

  const secretName = item.title;
  if (usesOpen)
    return (
      <VaultItemUses
        scope={scope}
        name={item.name}
        title={item.title}
        onBack={() => setUsesOpen(false)}
      />
    );
  return (
    <div data-testid="vault-item-detail" className="flex flex-col gap-4">
      <VaultPageHeader
        title={item.title}
        leading={<VaultTile kind={kind} title={item.title} origin={item.origin} />}
        subtitle={
          kind ? (
            one[kind]
          ) : (
            <Trans>These saved settings can't be read. Remove it and add it again.</Trans>
          )
        }
        onBack={() => !busy && onClose()}
      />
      {rows.length ? <div>{rows}</div> : null}
      <VaultItemActivity scope={scope} name={item.name} onOpen={() => setUsesOpen(true)} />
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      {confirmingRemove ? (
        <div className="flex flex-col gap-2">
          <p className="text-body-sm text-foreground">
            <Trans>Remove {secretName}? Bots will no longer be able to use it.</Trans>
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              data-testid="vault-item-remove-confirm"
              disabled={busy}
              onClick={() => void onRemove()}
            >
              <Trans>Remove</Trans>
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmingRemove(false)}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {auth ? (
            <Button
              type="button"
              variant="secondary"
              data-testid="vault-item-edit"
              disabled={busy || revealing}
              onClick={() => void edit()}
            >
              <Trans>Edit</Trans>
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            data-testid="vault-item-remove"
            disabled={busy}
            onClick={() => {
              hide();
              setConfirmingRemove(true);
            }}
          >
            <Trans>Remove</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
