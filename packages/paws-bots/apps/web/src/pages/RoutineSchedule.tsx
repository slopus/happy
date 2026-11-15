import { Trans, useLingui } from "@lingui/react/macro";
import type { CronFreq, CronPreset, CronUnit } from "@rakazo/core";
import {
  CRON_FREQS,
  clampIntervalAmount,
  cronFromPreset,
  cronIntervalAmounts,
  localizedClock,
  russianIntervalUnit,
} from "@rakazo/core";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { Clock, X } from "lucide-react";
import { cronFreqLabel, cronUnitLabel } from "../lib/cron";

const UNITS: CronUnit[] = ["minutes", "hours", "days"];
const TIMES = [
  "6:00 AM",
  "7:00 AM",
  "8:00 AM",
  "9:00 AM",
  "12:00 PM",
  "3:00 PM",
  "6:00 PM",
  "9:00 PM",
];

const TIMED: CronFreq[] = ["Every day", "Weekdays", "Every week", "Every month"];

function russianIntervalControlLead(): string {
  // The amount select stays visible for 1, so use a construction that keeps
  // the number in the sentence grammatical: “Раз в 1 час”, “Раз в 2 часа”.
  return "Раз в";
}

export function RoutineSchedule({
  value,
  onChange,
  onRemove,
}: {
  value: CronPreset;
  onChange: (next: CronPreset) => void;
  onRemove: () => void;
}) {
  const { i18n, t } = useLingui();
  const times = TIMES.includes(value.time) ? TIMES : [...TIMES, value.time];
  const numbers = cronIntervalAmounts(value.unit, value.n);

  function patch(partial: Partial<CronPreset>) {
    onChange({ ...value, ...partial });
  }

  const intervalAmountSelect = (
    <NativeSelect
      size="sm"
      value={String(value.n)}
      aria-label={t`Interval amount`}
      onChange={(event) => patch({ n: Number(event.target.value) })}
    >
      {numbers.map((n) => (
        <NativeSelectOption key={n} value={n}>
          {n}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );

  const intervalUnitSelect = (
    <NativeSelect
      size="sm"
      value={value.unit}
      aria-label={t`Interval unit`}
      onChange={(event) => {
        const unit = event.target.value as CronUnit;
        patch({ unit, n: clampIntervalAmount(value.n, unit) });
      }}
    >
      {UNITS.map((unit) => (
        <NativeSelectOption key={unit} value={unit}>
          {i18n.locale === "ru" ? russianIntervalUnit(value.n, unit) : cronUnitLabel(unit)}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );

  const timeSelect = (
    <NativeSelect
      size="sm"
      value={value.time}
      aria-label={t`Time of day`}
      onChange={(event) => patch({ time: event.target.value })}
    >
      {times.map((time) => (
        <NativeSelectOption key={time} value={time}>
          {localizedClock(time, i18n.locale)}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );

  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5 px-0.5">
        <Clock size={16} strokeWidth={1.6} className="text-muted-foreground" aria-hidden />
        <span className="flex-1 text-body-lg text-foreground">
          <Trans>On a schedule</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Remove schedule`}
          onClick={onRemove}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-body text-muted-foreground">
        <NativeSelect
          size="sm"
          value={value.freq}
          aria-label={t`How often`}
          onChange={(event) => {
            const freq = event.target.value as CronFreq;
            if (freq === "Advanced") {
              patch({ freq, cron: cronFromPreset(value) });
              return;
            }
            patch({ freq });
          }}
        >
          {CRON_FREQS.map((freq) => (
            <NativeSelectOption key={freq} value={freq}>
              {cronFreqLabel(freq)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {value.freq === "Interval" ? (
          i18n.locale === "ru" ? (
            <>
              {russianIntervalControlLead()} {intervalAmountSelect} {intervalUnitSelect}
            </>
          ) : (
            <Trans>
              every {intervalAmountSelect} {intervalUnitSelect}
            </Trans>
          )
        ) : null}
        {TIMED.includes(value.freq) ? <Trans>at {timeSelect}</Trans> : null}
        {value.freq === "Advanced" ? (
          <Input
            value={value.cron}
            placeholder="*/3 * * * *"
            aria-label={t`Cron expression`}
            onChange={(event) => patch({ cron: event.target.value })}
            className="h-7 min-w-[120px] flex-1 font-mono text-body-sm md:text-body-sm"
          />
        ) : null}
      </div>
    </div>
  );
}
