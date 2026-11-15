import { useEffect, useState } from "react";
import { useWords } from "../labels.js";

export type SourceRecord = {
  value?: unknown;
  asOf?: string;
  fresh?: boolean;
  updating?: boolean;
  error?: string;
};

const CONNECT_HINT = /^(Connect|Reconnect) .+ to see live data\.?$/;

/** When a figure was last read: "Updated 3 min ago" while live, else "As of" its snapshot date. */
export function SourceStamp({ source }: { source?: SourceRecord }) {
  const words = useWords();
  const [now, setNow] = useState(() => Date.now());
  const fresh = source?.fresh === true;
  useEffect(() => {
    if (!fresh) return;
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [fresh]);
  if (!source || typeof source !== "object") return null;
  const time = typeof source.asOf === "string" ? Date.parse(source.asOf) : Number.NaN;
  const known = Number.isFinite(time);
  const when = known
    ? fresh
      ? words.t("updated", { ago: words.ago(now - time) })
      : words.t("asOf", {
          date: words.date(time, {
            dateStyle: "medium",
            // Date-only values describe a calendar day, not a local-time instant.
            ...(/^\d{4}-\d{2}-\d{2}$/.test(source.asOf ?? "") ? { timeZone: "UTC" } : {}),
          }),
        })
    : "";
  const error = typeof source.error === "string" && source.error ? source.error : "";
  const pill = source.updating
    ? words.t("updating")
    : error
      ? CONNECT_HINT.test(error)
        ? error
        : words.t("refreshFailed")
      : "";
  if (!when && !pill) return null;
  return (
    <span className="rk-stamp" title={known ? new Date(time).toISOString() : undefined}>
      {when ? <span>{when}</span> : null}
      {pill ? (
        <span className="rk-stamp-pill" data-error={(!source.updating && !!error) || undefined}>
          {pill}
        </span>
      ) : null}
    </span>
  );
}

/** A calm placeholder where a chart has nothing to draw, so the page never breaks. */
export function EmptyChart() {
  const words = useWords();
  return (
    <div className="rk-chart-empty" role="img" aria-label={words.t("noDataToChart")}>
      {words.t("noData")}
    </div>
  );
}
