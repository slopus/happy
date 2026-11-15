import { useLingui } from "@lingui/react/macro";
import { useLinkFavicon } from "@rakazo/chat-ui/web";
import type { BotSecretMetadata, VaultKind } from "@rakazo/contracts";
import { vaultItemSubtitle } from "@rakazo/contracts";
import { registrableDomain } from "@rakazo/core/egress";
import { cn } from "@rakazo/ui-web";
import type { LucideIcon } from "lucide-react";
import { Braces, CreditCard, KeyRound, MapPin, SquareTerminal } from "lucide-react";

export type VaultAuth = NonNullable<BotSecretMetadata["auth"]>;

const KIND_ICONS: Record<VaultKind, LucideIcon> = {
  login: KeyRound,
  card: CreditCard,
  contact: MapPin,
  api_key: Braces,
  variable: SquareTerminal,
};

export function useVaultKindLabels() {
  const { t } = useLingui();
  const one: Record<VaultKind, string> = {
    login: t`Login`,
    card: t`Card`,
    contact: t`Contact`,
    api_key: t`API key`,
    variable: t`Variable`,
  };
  const many: Record<VaultKind, string> = {
    login: t`Logins`,
    card: t`Cards`,
    contact: t`Contacts`,
    api_key: t`Keys`,
    variable: t`Variables`,
  };
  return { one, many };
}

export function siteHost(origin: string): string {
  return URL.canParse(origin) ? new URL(origin).host.replace(/^www\./, "") : origin;
}

/** The first letter or digit, so an IPv6 site shows "1", not "[". */
function initial(text: string): string | undefined {
  return Array.from(text)
    .find((char) => /[\p{L}\p{N}]/u.test(char))
    ?.toUpperCase();
}

/** The initial of a site's own name, so `app.example.com` shows "E", not "A". */
function siteLetter(origin: string | undefined): string | undefined {
  if (!origin || !URL.canParse(origin)) return undefined;
  const { hostname } = new URL(origin);
  return initial(registrableDomain(hostname) ?? hostname);
}

/**
 * An item's icon. A login shows its site's icon, fetched through the API, or else the site's first
 * letter on an inverted plate, as a site's own mark would stand out; everything else shows its kind.
 */
export function VaultTile({
  kind,
  title,
  origin,
  className,
}: {
  kind: VaultKind | null;
  title: string;
  /** A login's site, for its icon and letter. */
  origin?: string;
  className?: string;
}) {
  const login = kind === "login";
  const favicon = useLinkFavicon(login && origin ? origin : "");
  if (favicon.icon) {
    return (
      <img
        src={favicon.icon}
        alt=""
        aria-hidden
        draggable={false}
        onLoad={(event) => {
          // A 1×1 image is a tracking pixel, not an icon.
          const image = event.currentTarget;
          if (image.naturalWidth <= 1 || image.naturalHeight <= 1) favicon.unusable();
        }}
        onError={favicon.unusable}
        className={cn(
          "size-9 shrink-0 rounded-md border border-border/60 bg-favicon-plate object-contain p-1.5",
          className,
        )}
      />
    );
  }
  const Icon = kind ? KIND_ICONS[kind] : KeyRound;
  const letter = login ? (siteLetter(origin) ?? initial(title)) : undefined;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-md text-body font-semibold",
        letter ? "bg-foreground text-background" : "bg-accent text-foreground",
        className,
      )}
    >
      {letter ?? <Icon className="size-4" />}
    </span>
  );
}

/** The line under an item's title, the same on every surface. */
export function useVaultSubtitle() {
  const { t } = useLingui();
  const { one } = useVaultKindLabels();
  return (item: BotSecretMetadata): string =>
    vaultItemSubtitle(item, { apiKey: one.api_key, expires: (expiry) => t`Expires ${expiry}` });
}
