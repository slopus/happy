import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { AccessGrant } from "@rakazo/contracts";
import {
  Badge,
  Button,
  buttonVariants,
  Field,
  FieldLabel,
  Input,
  Spinner,
  toast,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { formatBillingAmount } from "../lib/billing";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

export function AdminAccessPage() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (!me.data?.isAdmin) return <Navigate to="/app" replace />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 font-medium">
          <Trans>Free access</Trans>
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
          <AccessGrantsPanel />
        </div>
      </main>
    </div>
  );
}

function AccessGrantsPanel() {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const grants = useQuery(queries.accessGrants.list.queryOptions());
  const [email, setEmail] = useState("");
  const [credits, setCredits] = useState("");
  const [months, setMonths] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const creditCents = Math.round(Number(credits || 0) * 100);
  const freeMonths = Number(months || 0);

  async function run(key: string, failure: string, call: () => Promise<unknown>) {
    setBusy(key);
    try {
      await call();
      await queryClient.invalidateQueries({ queryKey: queries.accessGrants.list.key() });
      return true;
    } catch (err) {
      toast.error(errorText(err, failure));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function grant(event: FormEvent) {
    event.preventDefault();
    const done = await run("grant", t`Could not grant access`, () =>
      rpc.accessGrants.create({ email, creditCents, freeMonths }),
    );
    if (done) {
      setEmail("");
      setCredits("");
      setMonths("");
    }
  }

  const list = grants.data ?? [];

  return (
    <>
      <form
        onSubmit={(event) => void grant(event)}
        className="grid gap-3 sm:grid-cols-[1fr_8rem_8rem_auto] sm:items-end"
      >
        <Field>
          <FieldLabel htmlFor="grant-email">
            <Trans>Email</Trans>
          </FieldLabel>
          <Input
            id="grant-email"
            type="email"
            value={email}
            maxLength={254}
            required
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="grant-credits">
            <Trans>Credits ($)</Trans>
          </FieldLabel>
          <Input
            id="grant-credits"
            type="number"
            min={0}
            max={1000}
            step={1}
            value={credits}
            onChange={(event) => setCredits(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="grant-months">
            <Trans>Free months</Trans>
          </FieldLabel>
          <Input
            id="grant-months"
            type="number"
            min={0}
            max={12}
            step={1}
            value={months}
            onChange={(event) => setMonths(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          disabled={busy !== null || !email.trim() || (creditCents <= 0 && freeMonths <= 0)}
        >
          {busy === "grant" ? <Trans>Granting…</Trans> : <Trans>Grant</Trans>}
        </Button>
      </form>

      {grants.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : grants.isError ? (
        <div role="alert" className="flex items-center gap-3 text-body text-destructive">
          {errorText(grants.error, t`Couldn't load grants`)}
          <Button variant="outline" size="sm" onClick={() => void grants.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : list.length === 0 ? null : (
        <ul
          data-testid="access-grants"
          className="divide-y divide-border rounded-xl border border-border"
        >
          {list.map((item) => (
            <li
              key={item.id}
              aria-label={item.email}
              className="flex items-center gap-3 px-4 py-3 text-body-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium">{item.email}</div>
                <div className="flex min-w-0 gap-3 text-muted-foreground">
                  {item.creditCents > 0 ? (
                    <span>{formatBillingAmount(item.creditCents, "usd", i18n.locale)}</span>
                  ) : null}
                  {item.freeMonths > 0 ? (
                    <span>
                      <Plural value={item.freeMonths} one="# free month" other="# free months" />
                    </span>
                  ) : null}
                  {item.createdBy ? <span className="truncate">{item.createdBy}</span> : null}
                </div>
              </div>
              <GrantStatus status={item.status} />
              {item.status === "pending" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(item.id, t`Could not revoke grant`, () =>
                      rpc.accessGrants.revoke({ id: item.id }),
                    )
                  }
                >
                  <Trans>Revoke</Trans>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function GrantStatus({ status }: { status: AccessGrant["status"] }) {
  if (status === "applied")
    return (
      <Badge variant="secondary">
        <Trans>Received</Trans>
      </Badge>
    );
  if (status === "revoked")
    return (
      <Badge variant="outline">
        <Trans>Revoked</Trans>
      </Badge>
    );
  return (
    <Badge variant="outline">
      <Trans>Pending</Trans>
    </Badge>
  );
}
