import { useLingui } from "@lingui/react/macro";
import type { PlanLimitWindow } from "@rakazo/contracts";
import { modelCreditsUsd, planUsagePercent } from "@rakazo/contracts";
import { formatTimeUntil } from "@rakazo/core";
import { Progress } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../lib/query";
import { useBilling } from "./SubscriptionGate";

/** Shared by the account menu and Settings > Usage; the server caches provider reads. */
export function usePlanUsage() {
  const queries = useSpaceQueries();
  const { status } = useBilling();
  const { data } = useQuery({ ...queries.usage.limits.queryOptions(), staleTime: 60_000 });
  const plans = data ?? [];
  return { plans, creditsUsd: modelCreditsUsd(status) };
}

function useFormatUsd() {
  const { i18n } = useLingui();
  return (value: number) =>
    new Intl.NumberFormat(i18n.locale, { style: "currency", currency: "USD" }).format(value);
}

/** What the account menu shows beside Usage, or null when there is nothing to watch. */
export function useUsageHint(): string | null {
  const { t } = useLingui();
  const { plans, creditsUsd } = usePlanUsage();
  const usd = useFormatUsd();
  const used = planUsagePercent(plans);
  if (used !== null) return t`${Math.round(used)}% used`;
  if (creditsUsd !== null) return t`${usd(creditsUsd)} left`;
  return null;
}

function WindowUsage({ window }: { window: PlanLimitWindow }) {
  const { t, i18n } = useLingui();
  const label = { session: t`Session`, week: t`Weekly`, month: t`Monthly` }[window.period];
  const used = Math.round(window.usedPercent);
  const reset = formatTimeUntil(window.resetsAt, i18n.locale);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-body-sm">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{used}%</span>
      </div>
      <Progress
        value={used}
        aria-label={label}
        className="mt-1.5 [&_[data-slot=progress-indicator]]:bg-link"
      />
      {reset ? (
        <p className="mt-1.5 truncate text-label text-muted-foreground">{t`Resets in ${reset}`}</p>
      ) : null}
    </div>
  );
}

/** Each subscription's allowances and the credit balance; the caller frames them. */
export function PlanUsageRows() {
  const { t } = useLingui();
  const { plans, creditsUsd } = usePlanUsage();
  const usd = useFormatUsd();
  return (
    <div className="divide-y divide-border">
      {plans.map((plan) => (
        <div key={plan.credentialId} data-testid="plan-limits" className="px-4 py-3">
          <div className="mb-2.5 flex items-baseline justify-between gap-3">
            <span className="text-body font-medium text-foreground">{plan.name}</span>
            {plan.label !== plan.name ? (
              <span className="min-w-0 truncate text-body-sm text-muted-foreground">
                {plan.label}
              </span>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-x-5 gap-y-3">
            {plan.windows.map((window) => (
              <WindowUsage key={window.period} window={window} />
            ))}
          </div>
        </div>
      ))}
      {creditsUsd !== null ? (
        <div
          data-testid="credit-balance"
          className="flex items-baseline justify-between gap-3 px-4 py-3"
        >
          <span className="text-body font-medium text-foreground">{t`Credits`}</span>
          <span className="text-body tabular-nums text-foreground">{t`${usd(creditsUsd)} left`}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Settings > Usage; renders nothing for a member with no subscription or credits. */
export function PlanUsage() {
  const { plans, creditsUsd } = usePlanUsage();
  if (!plans.length && creditsUsd === null) return null;
  return (
    <div className="mb-3 rounded-xl border border-border">
      <PlanUsageRows />
    </div>
  );
}
