import { Trans, useLingui } from "@lingui/react/macro";
import type {
  SpendingCurrency,
  SpendingLimit,
  SpendingPayment,
  SpendingPeriod,
  SpendingStatus,
} from "@rakazo/contracts";
import { SPENDING_CURRENCIES } from "@rakazo/contracts";
import { formatMinorAmount, parseLimitInput } from "@rakazo/core";
import { writeSaved } from "@rakazo/core/query";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/** The account's spending limit, once the user has a way to pay. */
export function SpendingLimitSettings() {
  const rpc = useSpaceRpc();
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const query = useQuery(queries.spendingLimit.get.queryOptions());
  const status = query.data;
  const [editing, setEditing] = useState<SpendingLimit | null>(null);
  const [amountText, setAmountText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payments = useQuery({
    ...queries.spendingLimit.payments.queryOptions(),
    enabled: Boolean(status?.shown),
  }).data;
  if (!status?.shown) return null;
  const { limit, spent } = status;
  const money = (amount: number, currency: string) =>
    formatMinorAmount(amount, currency, i18n.locale);
  const periods: Array<{ value: SpendingPeriod; label: string }> = [
    { value: "day", label: t`Daily` },
    { value: "week", label: t`Weekly` },
    { value: "month", label: t`Monthly` },
    { value: "none", label: t`No reset` },
  ];

  function summary({ amount, currency, period }: SpendingLimit) {
    const shown = money(amount, currency);
    if (period === "day") return t`${shown} a day`;
    if (period === "week") return t`${shown} a week`;
    if (period === "month") return t`${shown} a month`;
    return t`${shown} in total`;
  }

  function spentText({ currency, period }: SpendingLimit) {
    const shown = money(spent, currency);
    if (period === "day") return t`${shown} spent today`;
    if (period === "week") return t`${shown} spent this week`;
    if (period === "month") return t`${shown} spent this month`;
    return t`${shown} spent`;
  }

  function edit() {
    const start = limit ?? { amount: 0, currency: "usd" as const, period: "month" as const };
    setEditing(start);
    setAmountText(limit ? String(limit.amount / 100) : "");
    setError(null);
  }

  async function save(next: SpendingLimit | null) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved: SpendingStatus = await rpc.spendingLimit.set({ limit: next });
      await writeSaved(queryClient, queries.spendingLimit.get.queryKey(), () => saved);
      setEditing(null);
    } catch (err) {
      setError(errorText(err, t`Could not save spending limit`));
    } finally {
      setSaving(false);
    }
  }

  const amount = parseLimitInput(amountText);
  return (
    <SettingsGroup data-testid="spending-limit">
      <SettingsRow
        label={<Trans>Spending limit</Trans>}
        control={
          editing ? null : (
            <>
              <span className="text-body-sm text-muted-foreground">
                {limit ? summary(limit) : <Trans>None</Trans>}
              </span>
              <Button variant="outline" size="sm" onClick={edit}>
                {limit ? <Trans>Edit</Trans> : <Trans>Set</Trans>}
              </Button>
            </>
          )
        }
      >
        {limit && !editing ? (
          <p className="mt-1 text-body-sm text-muted-foreground">{spentText(limit)}</p>
        ) : null}
        {editing ? (
          <form
            className="mt-2 flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (amount !== null) void save({ ...editing, amount });
            }}
          >
            <Input
              aria-label={t`Amount`}
              inputMode="decimal"
              className="w-28"
              value={amountText}
              disabled={saving}
              autoFocus
              onChange={(event) => setAmountText(event.target.value)}
            />
            <Select
              value={editing.currency}
              onValueChange={(value) =>
                setEditing({ ...editing, currency: value as SpendingCurrency })
              }
              items={SPENDING_CURRENCIES.map((currency) => ({
                value: currency,
                label: currency.toUpperCase(),
              }))}
            >
              <SelectTrigger aria-label={t`Currency`} className="w-24" disabled={saving}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} align="start">
                <SelectGroup>
                  {SPENDING_CURRENCIES.map((currency) => (
                    <SelectItem key={currency} value={currency}>
                      {currency.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={editing.period}
              onValueChange={(value) => setEditing({ ...editing, period: value as SpendingPeriod })}
              items={periods}
            >
              <SelectTrigger aria-label={t`Resets`} className="w-32" disabled={saving}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} align="start">
                <SelectGroup>
                  {periods.map((period) => (
                    <SelectItem key={period.value} value={period.value}>
                      {period.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button type="submit" size="sm" disabled={saving || amount === null}>
              <Trans>Save</Trans>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setEditing(null)}
            >
              <Trans>Cancel</Trans>
            </Button>
            {limit ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={saving}
                onClick={() => void save(null)}
              >
                <Trans>Remove</Trans>
              </Button>
            ) : null}
          </form>
        ) : null}
        {error ? <p className="mt-1 text-body-sm text-destructive">{error}</p> : null}
      </SettingsRow>
      {payments?.length ? <RecentPayments payments={payments} money={money} /> : null}
    </SettingsGroup>
  );
}

const FIRST_PAYMENTS = 5;

function RecentPayments({
  payments,
  money,
}: {
  payments: SpendingPayment[];
  money: (amount: number, currency: string) => string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? payments : payments.slice(0, FIRST_PAYMENTS);
  return (
    <SettingsRow label={<Trans>Recent payments</Trans>}>
      <ul className="mt-1 divide-y divide-border" data-testid="spending-payments">
        {shown.map((payment) => (
          <li key={payment.id} className="flex items-baseline justify-between gap-4 py-2">
            <div className="min-w-0">
              <p className="truncate text-body-sm text-foreground">{payment.site}</p>
              <p className="truncate text-label text-muted-foreground">
                {[payment.botName, formatRelativeTime(payment.createdAt)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <span className="shrink-0 text-body-sm tabular-nums text-foreground">
              {money(payment.amount, payment.currency)}
            </span>
          </li>
        ))}
      </ul>
      {!all && payments.length > FIRST_PAYMENTS ? (
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setAll(true)}>
          <Trans>Show all</Trans>
        </Button>
      ) : null}
    </SettingsRow>
  );
}
