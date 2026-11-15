import { hostNavigate } from "../paws/runtime";
import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { BillingStatus, ByokInterval, ByokTier, HeldCreditAmount } from "@rakazo/contracts";
import {
  ByokIntervalSchema,
  ByokTierSchema,
  byokTierChangeOffered,
  byokYearlySavingsPercent,
  byokYearlySwitchSavings,
  COMPUTER_SIZE_SPECS,
  creditAmountChoices,
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  HeldCreditAmountSchema,
  isCancelledTrial,
  MODEL_CREDIT_AMOUNTS,
  ModelCreditAmountSchema,
} from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { cn } from "@rakazo/ui-web/lib/utils";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  billingDateLabel,
  formatBillingAmount,
  formatBillingDate,
  formatBillingPrice,
} from "../lib/billing";
import { desktopBridge } from "../lib/desktop";
import type { RpcClient } from "../lib/rpc";
import { rpc } from "../lib/rpc";
import { useSignOut } from "../lib/sign-out";
import { AccountMenu } from "./AccountMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { InfoTooltip } from "./InfoTooltip";

type CreditAmount = (typeof MODEL_CREDIT_AMOUNTS)[number];
type TierOffer = NonNullable<BillingStatus["byokTiers"]>[number];

/** Subscription states that still bill: access now, or resumed from the billing portal. */
const LIVE_STATES: BillingStatus["state"][] = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
];

function formatMonthlyUsd(cents: number, locale: string): string {
  return formatBillingPrice(
    { amount: cents, currency: "usd", interval: "month", intervalCount: 1 },
    locale,
  );
}

/** Monthly or yearly own-key plan, with what the yearly plan saves. */
function ByokIntervalToggle({
  monthlyCents,
  annualCents,
  value,
  onChange,
}: {
  monthlyCents: number;
  annualCents: number;
  value: ByokInterval;
  onChange: (interval: ByokInterval) => void;
}) {
  const { t } = useLingui();
  const savings = byokYearlySavingsPercent(monthlyCents, annualCents);
  const segment = "h-7 px-3 text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm";
  return (
    <ToggleGroup
      aria-label={t`Billing period`}
      value={[value]}
      onValueChange={([next]) => {
        if (next) onChange(ByokIntervalSchema.parse(next));
      }}
      spacing={1}
      className="shrink-0 rounded-lg bg-foreground/5 p-1"
    >
      <ToggleGroupItem value="month" className={segment}>
        <Trans>Monthly</Trans>
      </ToggleGroupItem>
      <ToggleGroupItem value="year" className={segment}>
        <Trans>Yearly</Trans>
        {savings > 0 ? <span className="text-success">−{savings}%</span> : null}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

/** What a tier costs every `interval`; null when it is not offered at that interval. */
function tierPriceCents(offer: TierOffer, interval: ByokInterval): number | null {
  return interval === "year" ? offer.annualPriceCents : offer.monthlyPriceCents;
}

/** "8 vCPU, 16 GB, 100 computer hours a month" */
function useTierComputer() {
  const { t } = useLingui();
  return (offer: TierOffer) => {
    const { vcpus, memoryGb } = COMPUTER_SIZE_SPECS[offer.computerSize];
    const hours = offer.computerHours;
    return t`${vcpus} vCPU, ${memoryGb} GB, ${hours} computer hours a month`;
  };
}

/** The own-key plan's tiers at `interval`, each with its price and computer. */
function ByokTierSelect({
  tiers,
  interval,
  value,
  disabled,
  onChange,
}: {
  tiers: TierOffer[];
  interval: ByokInterval;
  value: ByokTier;
  disabled?: boolean;
  onChange: (offer: TierOffer) => void;
}) {
  const { t, i18n } = useLingui();
  const computer = useTierComputer();
  const offered = tiers.flatMap((offer) => {
    const cents = tierPriceCents(offer, interval);
    return cents === null
      ? []
      : [
          {
            offer,
            price: formatBillingPrice(
              { amount: cents, currency: "usd", interval, intervalCount: 1 },
              i18n.locale,
            ),
          },
        ];
  });
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const chosen = offered.find(({ offer }) => offer.tier === next);
        if (chosen) onChange(chosen.offer);
      }}
      items={offered.map(({ offer }) => ({ value: offer.tier, label: offer.name }))}
    >
      <SelectTrigger aria-label={t`Plan`} className="min-w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        align="start"
        className="w-auto min-w-(--anchor-width)"
      >
        <SelectGroup>
          {offered.map(({ offer, price }) => (
            <SelectItem key={offer.tier} value={offer.tier} className="py-2">
              <span className="flex flex-col gap-0.5">
                <span>
                  {offer.name} · {price}
                </span>
                <span className="text-label text-muted-foreground">{computer(offer)}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** The free period's subscribe button, at the chosen tier and interval. */
function SubscribeLabel({ price, annualPrice }: { price: string; annualPrice: string | null }) {
  return annualPrice ? (
    <Trans>Subscribe for {annualPrice} / year</Trans>
  ) : (
    <Trans>Subscribe for {price} / month</Trans>
  );
}

export function CreditAmountSelect({
  value,
  onChange,
  monthly = false,
  compact = false,
}: {
  value: HeldCreditAmount;
  onChange: (amount: HeldCreditAmount) => void;
  monthly?: boolean;
  /** As tall as the buttons around it, for a row of controls. */
  compact?: boolean;
}) {
  const { t, i18n } = useLingui();
  const items = creditAmountChoices(value).map((amount) => ({
    value: amount,
    label: monthly
      ? formatMonthlyUsd(amount, i18n.locale)
      : formatBillingAmount(amount, "usd", i18n.locale),
  }));
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(HeldCreditAmountSchema.parse(next));
      }}
      items={items}
    >
      <SelectTrigger
        aria-label={monthly ? t`Monthly credits` : t`Credit amount`}
        className={cn(
          "w-full",
          !compact && "rounded-xl pr-3 pl-4 text-body-lg data-[size=default]:h-12",
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} className="py-2 text-body-lg">
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** The own-key plan's tiers side by side, Standard first, with monthly credits below. */
function TierPlans({
  status,
  tiers,
  features,
  interval,
  onIntervalChange,
  amount,
  onAmountChange,
  pending,
  choose,
}: {
  status: BillingStatus;
  tiers: TierOffer[];
  features: string[];
  interval: ByokInterval;
  onIntervalChange: (interval: ByokInterval) => void;
  amount: CreditAmount;
  onAmountChange: (amount: CreditAmount) => void;
  pending: boolean;
  choose: (ownKey: boolean, plan?: { tier: ByokTier; interval: ByokInterval }) => void;
}) {
  const { t, i18n } = useLingui();
  const [first] = tiers;
  /** A bigger tier's computer as a multiple of the first's, so the cards compare without specs. */
  const power = (offer: TierOffer, base: TierOffer) => {
    const times =
      COMPUTER_SIZE_SPECS[offer.computerSize].vcpus / COMPUTER_SIZE_SPECS[base.computerSize].vcpus;
    return t`A ${times}× more powerful computer for your bot`;
  };
  const powerDetail = (offer: TierOffer, base: TierOffer) => {
    const { memoryGb } = COMPUTER_SIZE_SPECS[offer.computerSize];
    const usage = Math.round(offer.computerHours / base.computerHours);
    return t`${memoryGb} GB of RAM and ${usage}× the computer time of ${base.name}. Time counts only while your bot uses its computer.`;
  };
  const credit = formatBillingAmount(amount, "usd", i18n.locale);
  const trialDays = status.trialDays;
  return (
    <>
      <div className="-mt-4 flex flex-col items-center gap-6 text-center">
        <p className="text-body text-muted-foreground">
          <Trans>Works with your ChatGPT or Claude plan, or an API key.</Trans>
        </p>
        {first?.annualPriceCents ? (
          <ByokIntervalToggle
            monthlyCents={first.monthlyPriceCents}
            annualCents={first.annualPriceCents}
            value={interval}
            onChange={onIntervalChange}
          />
        ) : null}
      </div>
      <div className="grid gap-4 min-[640px]:grid-cols-3">
        {tiers.map((offer, index) => {
          const yearly = interval === "year" && offer.annualPriceCents !== null;
          const monthlyCents = yearly
            ? Math.round(offer.annualPriceCents! / 12)
            : offer.monthlyPriceCents;
          const name = offer.name;
          return (
            <Card key={offer.tier} className={index === 0 ? "ring-2 ring-primary" : undefined}>
              <CardHeader>
                <h2 className="text-heading3 font-medium">{name}</h2>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                <p className="flex items-baseline gap-1">
                  <span className="text-display font-medium tracking-tight">
                    {formatBillingAmount(monthlyCents, "usd", i18n.locale)}
                  </span>
                  <span className="text-body text-muted-foreground">
                    <Trans>/ month</Trans>
                  </span>
                </p>
                <ul className="space-y-3 text-body">
                  {(index === 0 || !first ? features : [t`Everything in ${first.name}`]).map(
                    (feature) => (
                      <li key={feature} className="flex gap-2">
                        <Check
                          aria-hidden
                          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        />
                        <span>{feature}</span>
                      </li>
                    ),
                  )}
                  {first && index > 0 ? (
                    <li className="flex gap-2">
                      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span>{power(offer, first)}</span>
                      <InfoTooltip label={offer.name}>{powerDetail(offer, first)}</InfoTooltip>
                    </li>
                  ) : null}
                </ul>
              </CardContent>
              <CardFooter className="border-t-0 bg-transparent">
                <Button
                  className={index === 0 ? "w-full" : "w-full bg-background dark:bg-transparent"}
                  variant={index === 0 ? "default" : "outline"}
                  disabled={pending || !status.canManage}
                  aria-label={
                    status.trialAvailable ? t`Start ${name} trial` : t`Subscribe to ${name}`
                  }
                  onClick={() =>
                    choose(true, { tier: offer.tier, interval: yearly ? "year" : "month" })
                  }
                >
                  {status.trialAvailable ? (
                    <Trans>Start {trialDays}-day free trial</Trans>
                  ) : (
                    <Trans>Subscribe</Trans>
                  )}
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4 min-[640px]:flex-row min-[640px]:items-center">
          <div className="flex-1">
            <h2 className="text-heading3 font-medium">
              <Trans>No plan or key? Use credits</Trans>
            </h2>
            <p className="mt-1 text-body text-muted-foreground">
              <Trans>All {credit} goes to model usage.</Trans>
            </p>
          </div>
          <div className="min-[640px]:w-44">
            <CreditAmountSelect
              monthly
              compact
              value={amount}
              onChange={(next) => onAmountChange(ModelCreditAmountSchema.parse(next))}
            />
          </div>
          <Button
            className="bg-background min-[640px]:w-32 dark:bg-transparent"
            variant="outline"
            disabled={pending || !status.canManage || !status.creditPurchasesEnabled}
            aria-label={t`Subscribe to credits`}
            onClick={() => choose(false)}
          >
            <Trans>Subscribe</Trans>
          </Button>
        </CardContent>
      </Card>
    </>
  );
}

export function CreditChoice({
  status,
  client,
  dismissible = false,
}: {
  status: BillingStatus;
  client: RpcClient;
  dismissible?: boolean;
}) {
  const { t, i18n } = useLingui();
  const features = [
    t`Bots and browser automation`,
    t`Scheduled routines`,
    t`Web, desktop and mobile`,
  ];
  const trialDays = status.trialDays;
  const tiers = status.planLayout === "tiers" ? (status.byokTiers ?? []) : [];
  const [amount, setAmount] = useState<CreditAmount>(DEFAULT_MONTHLY_CREDIT_AMOUNT);
  const [interval, setByokInterval] = useState<ByokInterval>("month");
  const credit = formatBillingAmount(amount, "usd", i18n.locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { logOut, signingOut } = useSignOut("/sign-in", setError);
  // A choice that answers after the plans were closed must not leave the app.
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);
  function go(url: string) {
    if (!closed.current) hostNavigate(url);
  }
  // Reported once, as first shown, and only when required: opened from the app it is not a
  // first plan choice.
  useEffect(() => {
    if (dismissible) return;
    void Promise.resolve()
      .then(() =>
        rpc.analytics.screen({
          screen: "plans",
          surface: desktopBridge() ? "desktop" : "web",
          ...(status.planLayout ? { planLayout: status.planLayout } : {}),
        }),
      )
      .catch(() => undefined);
  }, []);
  async function choose(ownKey: boolean, plan?: { tier: ByokTier; interval: ByokInterval }) {
    setPending(true);
    setError(null);
    const terms = plan ?? { interval };
    try {
      if (ownKey && status.byokFreeUntil) {
        go((await client.billing.checkout(terms)).url);
      } else if (ownKey) {
        const { url } = await client.billing.selectFunding({ funding: "byok", ...terms });
        go(url ?? "/onboarding");
      } else {
        const { url } = await client.billing.purchaseCredits({
          amountCents: amount,
          monthly: true,
        });
        go(url);
      }
    } catch {
      setError(t`Could not open billing`);
    } finally {
      // Desktop opens the URL in the system browser and this page stays, so re-enable.
      setPending(false);
    }
  }
  return (
    <div
      data-testid="billing-paywall"
      className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-8 px-6 py-12"
    >
      {dismissible ? null : (
        <AccountMenu disabled={pending} signingOut={signingOut} onLogOut={() => void logOut()} />
      )}
      <h1 className={cn("text-heading1 font-medium", tiers.length > 1 && "text-center")}>
        <Trans>Choose how to use Rakazo</Trans>
      </h1>
      {tiers.length > 1 ? (
        <TierPlans
          status={status}
          tiers={tiers}
          features={features}
          interval={interval}
          onIntervalChange={setByokInterval}
          amount={amount}
          onAmountChange={setAmount}
          pending={pending}
          choose={choose}
        />
      ) : (
        <div className="grid gap-4 min-[480px]:grid-cols-2">
          <Card>
            <CardHeader>
              <h2 className="text-heading3 font-medium">
                <Trans>Your subscription or API key</Trans>
              </h2>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4">
              {status.byokPriceCents && status.byokAnnualPriceCents ? (
                <div className="flex h-12 items-center justify-between gap-3">
                  <p className="flex items-baseline gap-1">
                    <span className="text-display font-medium tracking-tight">
                      {formatBillingAmount(
                        interval === "year"
                          ? Math.round(status.byokAnnualPriceCents / 12)
                          : status.byokPriceCents,
                        "usd",
                        i18n.locale,
                      )}
                    </span>
                    <span className="text-body text-muted-foreground">
                      <Trans>/ month</Trans>
                    </span>
                  </p>
                  <ByokIntervalToggle
                    monthlyCents={status.byokPriceCents}
                    annualCents={status.byokAnnualPriceCents}
                    value={interval}
                    onChange={setByokInterval}
                  />
                </div>
              ) : (
                <p className="flex h-12 items-center text-display font-medium tracking-tight">
                  {status.byokPriceCents ? (
                    formatMonthlyUsd(status.byokPriceCents, i18n.locale)
                  ) : (
                    <Trans>Free</Trans>
                  )}
                </p>
              )}
              <p className="text-body text-muted-foreground">
                <Trans>Works with your ChatGPT or Claude plan.</Trans>
              </p>
              <ul className="space-y-3 text-body">
                {features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter className="border-t-0 bg-transparent">
              <Button
                className="w-full bg-background dark:bg-transparent"
                variant="outline"
                disabled={pending || !status.canManage}
                aria-label={
                  status.byokPriceCents && !status.trialAvailable
                    ? t`Subscribe with your own AI`
                    : undefined
                }
                onClick={() => void choose(true)}
              >
                {!status.byokPriceCents ? (
                  <Trans>Connect my own</Trans>
                ) : status.trialAvailable ? (
                  <Trans>Start {trialDays}-day free trial</Trans>
                ) : (
                  <Trans>Subscribe</Trans>
                )}
              </Button>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <h2 className="text-heading3 font-medium">
                <Trans>Credits</Trans>
              </h2>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4">
              <CreditAmountSelect
                monthly
                value={amount}
                onChange={(next) => setAmount(ModelCreditAmountSchema.parse(next))}
              />
              <p className="text-body text-muted-foreground">
                <Trans>All {credit} goes to model usage.</Trans>
              </p>
              <ul className="space-y-3 text-body">
                {[...features, t`Models at provider cost`].map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter className="border-t-0 bg-transparent">
              <Button
                className="w-full"
                disabled={pending || !status.canManage || !status.creditPurchasesEnabled}
                aria-label={t`Subscribe to credits`}
                onClick={() => void choose(false)}
              >
                <Trans>Subscribe</Trans>
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ModelCreditsSettings({
  status,
  refresh,
  client,
}: {
  status: BillingStatus;
  refresh: () => Promise<void>;
  /** Bound to the space the billing panel opened for, not the current selection. */
  client: RpcClient;
}) {
  const { t, i18n } = useLingui();
  const recurring =
    status.monthlyAmountCents && !["canceled", "none", "incomplete"].includes(status.state);
  const [chosenAmount, setChosenAmount] = useState<CreditAmount | null>(null);
  // Follows the plan until the owner picks an offered amount; only a live plan keeps a retired one.
  const amount: HeldCreditAmount =
    chosenAmount ??
    (recurring ? HeldCreditAmountSchema : ModelCreditAmountSchema)
      .catch(DEFAULT_MONTHLY_CREDIT_AMOUNT)
      .parse(status.monthlyAmountCents);
  const [topupAmount, setTopupAmount] = useState<CreditAmount>(MODEL_CREDIT_AMOUNTS[0]);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [interval, setByokInterval] = useState<ByokInterval>("month");
  const [endTrialOpen, setEndTrialOpen] = useState(false);
  const [yearlyOpen, setYearlyOpen] = useState(false);
  const [tierTarget, setTierTarget] = useState<TierOffer | null>(null);
  const [checkoutTier, setCheckoutTier] = useState<ByokTier>("standard");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"failed" | "uncharged" | null>(null);
  const computer = useTierComputer();
  const balance = new Intl.NumberFormat(i18n.locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(status.balanceUsd ?? 0);
  async function action(work: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof ORPCError && err.status === 402 ? "uncharged" : "failed");
    } finally {
      setPending(false);
    }
  }
  const freeUntil = status.byokFreeUntil
    ? formatBillingDate(status.byokFreeUntil, i18n.locale || "en")
    : null;
  const price = status.byokPriceCents
    ? formatBillingAmount(status.byokPriceCents, "usd", i18n.locale)
    : null;
  const annualPrice = status.byokAnnualPriceCents
    ? formatBillingAmount(status.byokAnnualPriceCents, "usd", i18n.locale)
    : null;
  // A live subscription without monthly credits is the own-key plan, at the price it was bought at.
  const ownKeyPlan =
    status.funding === "byok" &&
    status.byokPriceCents &&
    !status.monthlyAmountCents &&
    LIVE_STATES.includes(status.state) &&
    !status.byokFreeUntil
      ? {
          price: formatBillingPrice(
            {
              amount: status.byokPriceCents,
              currency: "usd",
              interval: status.byokInterval ?? "month",
              intervalCount: 1,
            },
            i18n.locale,
          ),
          date: billingDateLabel(status, i18n.locale || "en"),
        }
      : null;
  const yearlySavings = byokYearlySwitchSavings(status);
  const tiers = status.byokTiers ?? [];
  const currentTier = tiers.find(
    (offer) => offer.tier === ByokTierSchema.catch("standard").parse(status.byokTier),
  );
  const tierChange = byokTierChangeOffered(status) && currentTier;
  const subscribedInterval = status.byokInterval ?? "month";
  const tierTargetName = tierTarget?.name;
  const tierTargetPrice = tierTarget && tierPriceCents(tierTarget, subscribedInterval);
  const tierTargetLabel = tierTargetPrice
    ? formatBillingPrice(
        {
          amount: tierTargetPrice,
          currency: "usd",
          interval: subscribedInterval,
          intervalCount: 1,
        },
        i18n.locale,
      )
    : null;
  // A free period subscribes at the tier it picks; without tiers, the plan's own prices apply.
  const checkoutOffer = tiers.find((offer) => offer.tier === checkoutTier);
  const checkoutMonthlyCents = checkoutOffer?.monthlyPriceCents ?? status.byokPriceCents;
  const checkoutAnnualCents = checkoutOffer
    ? checkoutOffer.annualPriceCents
    : status.byokAnnualPriceCents;
  const checkoutPrice = checkoutMonthlyCents
    ? formatBillingAmount(checkoutMonthlyCents, "usd", i18n.locale)
    : null;
  const checkoutAnnualPrice = checkoutAnnualCents
    ? formatBillingAmount(checkoutAnnualCents, "usd", i18n.locale)
    : null;
  return (
    <div data-testid="model-credits" className="space-y-5">
      {ownKeyPlan ? (
        <div data-testid="own-key-plan" className="rounded-xl border border-border p-5">
          <h3 className="text-body text-muted-foreground">
            <Trans>Your subscription or API key</Trans>
          </h3>
          <p className="mt-2 text-display font-medium tabular-nums">{ownKeyPlan.price}</p>
          {ownKeyPlan.date ? (
            <p className="mt-2 text-body text-muted-foreground">{ownKeyPlan.date}</p>
          ) : null}
          {currentTier ? (
            <p className="mt-2 text-body text-muted-foreground">
              {tierChange
                ? computer(currentTier)
                : `${currentTier.name} · ${computer(currentTier)}`}
            </p>
          ) : null}
          {tierChange || yearlySavings !== null ? (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {tierChange ? (
                <ByokTierSelect
                  tiers={tiers}
                  interval={subscribedInterval}
                  value={currentTier.tier}
                  disabled={pending}
                  onChange={(offer) => {
                    if (offer.tier !== currentTier.tier) setTierTarget(offer);
                  }}
                />
              ) : null}
              {yearlySavings !== null ? (
                <Button variant="secondary" disabled={pending} onClick={() => setYearlyOpen(true)}>
                  <Trans>Switch to yearly</Trans>
                  <span className="text-success">−{yearlySavings}%</span>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="rounded-xl border border-border p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-body text-muted-foreground">
            <Trans>Available credits</Trans>
          </h3>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t`Refresh credits`}
            disabled={pending}
            onClick={() => void action(refresh)}
          >
            <Trans>Refresh</Trans>
          </Button>
        </div>
        <p className="mt-2 text-display font-medium tabular-nums">{balance}</p>
        <p className="mt-2 text-body text-muted-foreground">
          {status.funding === "byok" && freeUntil ? (
            <Trans>Using your API key. Free plan ends {freeUntil}.</Trans>
          ) : status.funding === "byok" ? (
            <Trans>Using your API key</Trans>
          ) : (
            <Trans>Monthly credits expire at renewal. Top-ups do not expire.</Trans>
          )}
        </p>
        {status.canManage ? (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {freeUntil && tiers.length > 1 ? (
              <ByokTierSelect
                tiers={tiers}
                interval={interval}
                value={checkoutTier}
                disabled={pending}
                onChange={(offer) => setCheckoutTier(offer.tier)}
              />
            ) : null}
            {freeUntil && checkoutMonthlyCents && checkoutAnnualCents ? (
              <ByokIntervalToggle
                monthlyCents={checkoutMonthlyCents}
                annualCents={checkoutAnnualCents}
                value={interval}
                onChange={setByokInterval}
              />
            ) : null}
            {freeUntil && checkoutPrice ? (
              <Button
                disabled={pending}
                onClick={() =>
                  void action(async () => {
                    const { url } = await client.billing.checkout({
                      interval: checkoutAnnualPrice ? interval : "month",
                      ...(checkoutOffer ? { tier: checkoutTier } : {}),
                    });
                    hostNavigate(url);
                  })
                }
              >
                <SubscribeLabel
                  price={checkoutPrice}
                  annualPrice={interval === "year" ? checkoutAnnualPrice : null}
                />
              </Button>
            ) : null}
            <Button
              variant={freeUntil ? "secondary" : "default"}
              disabled={!status.creditPurchasesEnabled}
              onClick={() => setPurchaseOpen(true)}
            >
              <Trans>Add credits</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      {status.computerHoursLeft != null ? (
        <div className="rounded-xl border border-border p-5">
          <h3 className="text-body text-muted-foreground">
            <Trans>Computer hours left</Trans>
          </h3>
          <p className="mt-2 text-display font-medium tabular-nums">{status.computerHoursLeft}</p>
          {status.computerHoursResetAt ? (
            <p className="mt-2 text-body text-muted-foreground">
              <Trans>
                Resets {formatBillingDate(status.computerHoursResetAt, i18n.locale || "en")}
              </Trans>
            </p>
          ) : null}
          {status.canManage && status.state === "trialing" && !status.cancelAtPeriodEnd ? (
            <>
              <p className="mt-2 text-body text-muted-foreground">
                <Trans>Trials get fewer hours to prevent abuse.</Trans>
              </p>
              <Button
                className="mt-5"
                variant="secondary"
                disabled={pending}
                onClick={() => setEndTrialOpen(true)}
              >
                <Trans>Start plan now</Trans>
              </Button>
            </>
          ) : isCancelledTrial(status) ? (
            <>
              <p className="mt-2 text-body text-muted-foreground">
                <Trans>Cancelled trials have no computer hours.</Trans>
              </p>
              {status.canManage && status.hasCustomer ? (
                <Button
                  className="mt-5"
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      const { url } = await client.billing.portal();
                      hostNavigate(url);
                    })
                  }
                >
                  <Trans>Renew plan</Trans>
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={endTrialOpen}
        onCancel={() => setEndTrialOpen(false)}
        variant="default"
        title={<Trans>Start your plan now?</Trans>}
        description={
          price ? (
            <Trans>Your trial ends and your card is charged {price} today.</Trans>
          ) : (
            <Trans>Your trial ends and your card is charged today.</Trans>
          )
        }
        confirmDisabled={pending}
        onConfirm={() =>
          void action(async () => {
            setEndTrialOpen(false);
            await client.billing.endTrial();
            await refresh();
          })
        }
        confirmLabel={<Trans>Start plan</Trans>}
      />
      <ConfirmDialog
        open={yearlyOpen}
        onCancel={() => setYearlyOpen(false)}
        variant="default"
        title={<Trans>Switch to yearly?</Trans>}
        description={
          status.state === "trialing" ? (
            <Trans>Your plan becomes {annualPrice} / year when your trial ends.</Trans>
          ) : (
            <Trans>
              Your card is charged {annualPrice} today, less the unused part of this month.
            </Trans>
          )
        }
        confirmDisabled={pending}
        onConfirm={() =>
          void action(async () => {
            setYearlyOpen(false);
            await client.billing.switchToYearly();
            await refresh();
          })
        }
        confirmLabel={<Trans>Switch</Trans>}
      />
      <AlertDialog
        open={tierTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTierTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Switch to {tierTargetName}?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {status.state === "trialing" ? (
                <Trans>Your plan becomes {tierTargetLabel} when your trial ends.</Trans>
              ) : (tierTargetPrice ?? 0) > (status.byokPriceCents ?? 0) ? (
                <Trans>Your card is charged the prorated difference today.</Trans>
              ) : (
                <Trans>The unused difference is credited to your next invoice.</Trans>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() =>
                void action(async () => {
                  const tier = tierTarget?.tier;
                  setTierTarget(null);
                  if (!tier) return;
                  await client.billing.changeTier({ tier });
                  await refresh();
                })
              }
            >
              <Trans>Switch</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {status.canManage ? (
        <div className="rounded-xl border border-border p-5">
          <h3 className="font-medium">
            <Trans>Monthly credits</Trans>
          </h3>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <CreditAmountSelect
              monthly
              compact
              value={amount}
              onChange={(next) =>
                setChosenAmount(ModelCreditAmountSchema.safeParse(next).data ?? null)
              }
            />
            <Button
              variant="secondary"
              disabled={
                pending ||
                !status.creditPurchasesEnabled ||
                Boolean(recurring && amount === status.monthlyAmountCents)
              }
              onClick={() =>
                void action(async () => {
                  if (recurring) {
                    await client.billing.setMonthlyCredits({
                      amountCents: ModelCreditAmountSchema.parse(amount),
                    });
                    await refresh();
                  } else {
                    const { url } = await client.billing.purchaseCredits({
                      amountCents: ModelCreditAmountSchema.parse(amount),
                      monthly: true,
                    });
                    hostNavigate(url);
                  }
                })
              }
            >
              {recurring ? (
                amount > (status.monthlyAmountCents ?? 0) ? (
                  <Trans>Upgrade now</Trans>
                ) : amount < (status.monthlyAmountCents ?? 0) ? (
                  <Trans>Downgrade at renewal</Trans>
                ) : (
                  <Trans>Update</Trans>
                )
              ) : (
                <Trans>Subscribe</Trans>
              )}
            </Button>
          </div>
          {status.hasCustomer ? (
            <Button
              className="mt-4"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                void action(async () => {
                  const { url } = await client.billing.portal();
                  hostNavigate(url);
                })
              }
            >
              <Trans>Manage billing</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      {status.canManage && status.funding === "byok" && (status.balanceUsd ?? 0) > 0 ? (
        <Button
          variant="ghost"
          disabled={pending || !status.creditPurchasesEnabled}
          onClick={() =>
            void action(async () => {
              await client.billing.selectFunding({ funding: "credits" });
              window.location.reload();
            })
          }
        >
          <Trans>Use Rakazo credits</Trans>
        </Button>
      ) : null}
      {status.canManage && status.funding !== "byok" && (!recurring || status.cancelAtPeriodEnd) ? (
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() =>
            void action(async () => {
              const { url } = await client.billing.selectFunding({ funding: "byok" });
              hostNavigate(url ?? "/app?settings=models");
            })
          }
        >
          <Trans>Use my subscription or API key</Trans>
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-body text-destructive">
          {error === "uncharged" ? (
            <Trans>Your card was not charged</Trans>
          ) : (
            <Trans>Could not update billing</Trans>
          )}
        </p>
      ) : null}
      <Dialog open={purchaseOpen} onOpenChange={setPurchaseOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              <Trans>Add credits</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>One-time purchase. Credits do not expire.</Trans>
            </DialogDescription>
          </DialogHeader>
          <CreditAmountSelect
            value={topupAmount}
            onChange={(next) => setTopupAmount(ModelCreditAmountSchema.parse(next))}
          />
          <Button
            disabled={pending}
            onClick={() =>
              void action(async () => {
                const { url } = await client.billing.purchaseCredits({
                  amountCents: topupAmount,
                  monthly: false,
                });
                hostNavigate(url);
              })
            }
          >
            <Trans>Continue to checkout</Trans>
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
