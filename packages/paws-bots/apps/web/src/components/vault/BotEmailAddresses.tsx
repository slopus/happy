import { Trans, useLingui } from "@lingui/react/macro";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Mail } from "lucide-react";
import { useCopyText } from "../../lib/copy-text";
import { useSpaceQueries } from "../../lib/query";

/** The addresses the bots use to sign up and receive mail, beside the logins they use. */
export function BotEmailAddresses() {
  const queries = useSpaceQueries();
  const email = useQuery(queries.bots.emailAddresses.queryOptions()).data;
  if (!email?.addresses.length) return null;
  return (
    <section data-testid="vault-bot-emails" className="pt-2">
      <SectionHeading variant="label" className="mb-2">
        <Trans>Bot email addresses</Trans>
      </SectionHeading>
      <ul className="overflow-hidden rounded-xl bg-muted/50">
        {email.addresses.map((row) => (
          <BotEmailRow key={row.botId} botName={row.botName} address={row.address} />
        ))}
      </ul>
    </section>
  );
}

function BotEmailRow({ botName, address }: { botName: string; address: string }) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <li className="flex items-center gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Mail className="size-4" strokeWidth={1.6} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-foreground">{botName}</span>
        <span className="block truncate font-mono text-label text-muted-foreground">{address}</span>
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? t`Copied` : t`Copy ${address}`}
        onClick={() => copy(address)}
        className="text-muted-foreground"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </li>
  );
}
