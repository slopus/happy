import type { CSSProperties, ReactNode } from "react";
import { Fragment } from "react";
import type { Formatter, LegendItem } from "./dataviz.js";
import {
  axisGutter,
  ChartTip,
  EmptyChart,
  finite,
  formatValue,
  ReferenceLine,
  SeriesLegend,
  seriesColor,
  textWidth,
  useActive,
  useWidth,
  ValueGrid,
  valueScale,
} from "./dataviz.js";
import { objectItems } from "./items.js";
import { useWords } from "./labels.js";

const PLOT = { top: 10, bottom: 22, right: 4 };

/**
 * Up to five evenly spaced x labels that do not touch, first and last always. Points without a
 * label are skipped, so a page labelling every other point still gets its labels spread out.
 * The chart's two end points draw inward, so every label is checked at the extent it is drawn at.
 */
function lineLabels(labels: string[], x: (index: number) => number): number[] {
  const labelled = labels.flatMap((label, index) => (label ? [index] : []));
  const count = labelled.length;
  if (count < 3) return labelled;
  const extent = (index: number) => {
    const width = textWidth(labels[index] ?? "");
    const at = x(index);
    if (index === 0) return [at, at + width] as const;
    return index === labels.length - 1
      ? ([at - width, at] as const)
      : ([at - width / 2, at + width / 2] as const);
  };
  const last = count - 1;
  for (let step = Math.ceil(last / 4); step < last; step++) {
    const shown: number[] = [];
    for (let at = 0; at < last; at += step) shown.push(labelled[at]!);
    if (last - labelled.indexOf(shown[shown.length - 1]!) < step / 2) shown.pop();
    shown.push(labelled[last]!);
    if (shown.every((index, at) => at === 0 || extent(shown[at - 1]!)[1] + 8 <= extent(index)[0])) {
      return shown;
    }
  }
  return [labelled[0]!, labelled[last]!];
}

type LinePoint = { label?: ReactNode; value: number };
type LineSeries = { label?: ReactNode; values: number[] };
type Annotation = {
  at: number | "zero";
  label: ReactNode;
  line?: number | boolean;
  value?: number;
};

const text = (node: unknown) =>
  typeof node === "string" || typeof node === "number" ? String(node) : "";

/** Path through the finite values; a missing value breaks the line instead of bridging it. */
function linePath(
  values: (number | undefined)[],
  x: (i: number) => number,
  y: (v: number) => number,
) {
  let path = "";
  let pen = false;
  values.forEach((value, index) => {
    if (!finite(value)) {
      pen = false;
      return;
    }
    path += `${pen ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`;
    pen = true;
  });
  return path;
}

/**
 * A trend over labelled points. One series gets an area fill; extra `lines` add series with
 * dots, `secondary` adds a grey comparison, and `annotations` pin notes to points.
 */
export function LineChart({
  points = [],
  floor,
  ceiling,
  unit,
  format,
  lines,
  secondary,
  labels,
  annotations,
  legend = true,
}: {
  points?: LinePoint[];
  floor?: number;
  ceiling?: number;
  unit?: string;
  format?: Formatter;
  lines?: LineSeries[];
  secondary?: LineSeries;
  labels?: ReactNode[];
  annotations?: Annotation[];
  legend?: boolean;
}) {
  const words = useWords();
  const { ref, width } = useWidth(560);
  const base = (Array.isArray(points) ? points : []).filter(
    (point) => point && typeof point === "object",
  );
  const extra = (Array.isArray(lines) ? lines : []).filter(
    (line) => line && Array.isArray(line.values),
  );
  const series = [
    {
      name: labels?.[0],
      values: base.map((point) => (finite(point.value) ? point.value : undefined)),
    },
    ...extra.map((line, index) => ({
      name: line.label ?? labels?.[index + 1],
      values: line.values.map((v) => (finite(v) ? v : undefined)),
    })),
  ];
  const comparison =
    secondary && Array.isArray(secondary.values)
      ? {
          name: secondary.label,
          values: secondary.values.map((v) => (finite(v) ? v : undefined)),
        }
      : undefined;
  const count = Math.max(0, ...series.map((s) => s.values.length), comparison?.values.length ?? 0);
  const all = [...series, ...(comparison ? [comparison] : [])].flatMap((s) =>
    s.values.filter(finite),
  );
  const scale = valueScale(all.length ? all : [0], floor, ceiling);
  const label = (v: number) => formatValue(v, unit, format, words);
  const left = axisGutter(scale.ticks.map(label));
  const right = width - PLOT.right;
  const height = width >= 480 ? 264 : 220;
  const baseline = height - PLOT.bottom;
  const x = (index: number) =>
    left + (count > 1 ? (index / (count - 1)) * (right - left) : (right - left) / 2);
  const y = (value: number) =>
    baseline -
    ((Math.min(scale.high, Math.max(scale.low, value)) - scale.low) / (scale.high - scale.low)) *
      (baseline - PLOT.top);
  const hover = useActive(count, (px) =>
    count === 0 || px < left - 12 || px > right + 4
      ? null
      : Math.min(
          count - 1,
          Math.max(0, Math.round(((px - left) / Math.max(1, right - left)) * (count - 1))),
        ),
  );
  if (all.length === 0) return <EmptyChart />;
  const multi = series.length > 1;
  const zero = y(Math.max(scale.low, Math.min(scale.high, 0)));
  const primary = series[0]!.values;
  const firstIndex = primary.findIndex(finite);
  const lastIndex = primary.length - 1 - [...primary].reverse().findIndex(finite);
  const area =
    !multi &&
    firstIndex >= 0 &&
    primary.every((v, i) => i < firstIndex || i > lastIndex || finite(v))
      ? `${linePath(primary, x, y)}L${x(lastIndex)} ${zero}L${x(firstIndex)} ${zero}Z`
      : "";
  const tickLabels = base.map((point) => text(point.label));
  const shownLabels = lineLabels(tickLabels, x);
  const keyItems: LegendItem[] = [
    ...series.flatMap((s, index) =>
      s.name != null && s.name !== ""
        ? [{ name: s.name, color: seriesColor(index), mark: "line" as const }]
        : [],
    ),
    ...(comparison?.name != null && comparison.name !== ""
      ? [{ name: comparison.name, color: "var(--rk-other)", mark: "dash" as const }]
      : []),
  ];
  const marks = (Array.isArray(annotations) ? annotations : [])
    .filter(
      (note) =>
        note && (note.at === "zero" || (finite(note.at) && note.at >= 0 && note.at < count)),
    )
    .slice(0, 3 * Math.max(1, count));
  const active = hover.active;
  const description = series
    .map(
      (s, index) =>
        `${text(s.name) || (index ? words.t("series", { n: index + 1 }) : words.t("values"))}: ${s.values
          .map((v, i) => `${tickLabels[i] || i + 1} ${finite(v) ? label(v) : words.t("none")}`)
          .join(", ")}`,
    )
    .join(". ");
  return (
    <div className="rk-chart rk-frame" ref={ref}>
      {legend !== false && keyItems.length > 0 ? <SeriesLegend items={keyItems} /> : null}
      <div className="rk-plot">
        <svg
          role="img"
          className="rk-focus-ring"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          {...hover.props}
        >
          <title>{description}</title>
          <ValueGrid ticks={scale.ticks} y={y} left={left} right={right} label={label} />
          {shownLabels.map((index) =>
            tickLabels[index] ? (
              <text
                key={index}
                className="rk-tick"
                x={x(index)}
                y={height - 4}
                textAnchor={
                  count < 2
                    ? "middle"
                    : index === 0
                      ? "start"
                      : index === count - 1
                        ? "end"
                        : "middle"
                }
              >
                {base[index]?.label}
              </text>
            ) : null,
          )}
          {area ? <path className="rk-line-area" d={area} /> : null}
          {comparison ? (
            <path className="rk-line-secondary" d={linePath(comparison.values, x, y)} />
          ) : null}
          {series.map((s, index) => (
            <g key={index} style={{ "--rk-series": seriesColor(index) } as CSSProperties}>
              <path className="rk-line rk-draw" pathLength={1} d={linePath(s.values, x, y)} />
              {s.values.map((v, i) => {
                // A point with no neighbour draws no line, so it gets a dot; one alone, its value.
                const alone = !finite(s.values[i - 1]) && !finite(s.values[i + 1]);
                if (!finite(v) || !(multi || alone)) return null;
                const only = alone && series.length === 1 && s.values.filter(finite).length === 1;
                return (
                  <Fragment key={i}>
                    <circle className="rk-line-dot" cx={x(i)} cy={y(v)} r={alone ? 3.5 : 2.5} />
                    {only ? (
                      <text
                        className="rk-line-value"
                        x={x(i)}
                        y={y(v) - 10}
                        textAnchor={
                          x(i) > right - 40 ? "end" : x(i) < left + 40 ? "start" : "middle"
                        }
                      >
                        {label(v)}
                      </text>
                    ) : null}
                  </Fragment>
                );
              })}
            </g>
          ))}
          {marks.map((note, index) => {
            if (note.at === "zero") {
              return (
                <ReferenceLine
                  key={index}
                  y={zero}
                  left={left}
                  right={right}
                  end={right}
                  label={note.label}
                />
              );
            }
            const at = note.at;
            const owner =
              typeof note.line === "number" && series[note.line]
                ? note.line
                : note.line === true
                  ? -1
                  : 0;
            const v = finite(note.value)
              ? note.value
              : (series[Math.max(0, owner)]?.values[at] ?? primary[at]);
            const width = textWidth(text(note.label));
            const cx = x(at);
            // Kept inside the plot: a note near either edge reads inward from its point.
            const anchor =
              cx + width / 2 > right ? "end" : cx - width / 2 < left ? "start" : "middle";
            if (!finite(v)) {
              // No value to sit on: the note marks the moment across the plot instead.
              return (
                <g key={index} className="rk-annotation">
                  <line x1={cx} x2={cx} y1={PLOT.top + 14} y2={baseline} strokeDasharray="3 3" />
                  <text x={cx} y={PLOT.top + 8} textAnchor={anchor}>
                    {text(note.label)}
                  </text>
                </g>
              );
            }
            const neighbours = [primary[at - 1], primary[at + 1]].filter(finite);
            const above =
              neighbours.length === 0 ||
              v >= neighbours.reduce((a, b) => a + b, 0) / neighbours.length;
            const cy = y(v);
            return (
              <g key={index} className="rk-annotation">
                <line x1={cx} x2={cx} y1={above ? cy - 5 : cy + 5} y2={above ? cy - 11 : cy + 11} />
                <circle
                  cx={cx}
                  cy={cy}
                  r={3.5}
                  style={{ fill: owner < 0 ? "var(--rk-other)" : seriesColor(owner) }}
                />
                <text
                  x={cx}
                  y={above ? cy - 15 : cy + 15}
                  dy={above ? 0 : "0.7em"}
                  textAnchor={anchor}
                >
                  {text(note.label)}
                </text>
              </g>
            );
          })}
          {active !== null ? (
            <g className="rk-hover">
              <line
                className="rk-crosshair"
                x1={x(active)}
                x2={x(active)}
                y1={PLOT.top}
                y2={baseline}
              />
              {series.map((s, index) => {
                const v = s.values[active];
                return finite(v) ? (
                  <circle
                    key={index}
                    className="rk-hover-dot"
                    cx={x(active)}
                    cy={y(v)}
                    r={4}
                    style={{ fill: seriesColor(index) }}
                  />
                ) : null;
              })}
            </g>
          ) : null}
        </svg>
        <ChartTip
          width={width}
          tip={
            active === null
              ? null
              : {
                  x: x(active),
                  y:
                    Math.min(
                      ...series
                        .map((s) => s.values[active])
                        .filter(finite)
                        .map(y),
                      baseline,
                    ) - 8,
                  title: base[active]?.label,
                  rows: [
                    ...series.map((s, index) => ({
                      name: s.name ?? (multi ? words.t("series", { n: index + 1 }) : undefined),
                      value: finite(s.values[active])
                        ? label(s.values[active]!)
                        : words.t("noValue"),
                      color: seriesColor(index),
                    })),
                    ...(comparison
                      ? [
                          {
                            name: comparison.name ?? words.t("comparison"),
                            value: finite(comparison.values[active])
                              ? label(comparison.values[active]!)
                              : words.t("noValue"),
                            color: "var(--rk-other)",
                          },
                        ]
                      : []),
                  ],
                }
          }
        />
      </div>
    </div>
  );
}

export type Bar = { label: ReactNode; value: number; display?: ReactNode };

/**
 * Without a choice the longest bar is inked and the rest recede; "none" inks every bar.
 * A negative value draws in the negative colour, scaled against the largest size either way.
 */
export function Bars({ bars = [], emphasis }: { bars?: Bar[]; emphasis?: number | "none" }) {
  const words = useWords();
  const rows = objectItems(bars);
  const values = rows.map((bar) => (finite(bar.value) ? bar.value : 0));
  const max = Math.max(0, ...values.map(Math.abs));
  // The longest bar, negative or not, since a bar's length is its size.
  const chosen = emphasis === undefined ? values.map(Math.abs).indexOf(max) : emphasis;
  if (rows.length === 0) return null;
  return (
    <ul className="rk-bars rk-frame">
      {rows.map((bar, index) => {
        const value = values[index]!;
        const share = max > 0 ? Math.min(1, Math.abs(value) / max) : 0;
        return (
          <li
            className="rk-bar"
            key={index}
            data-emphasis={chosen === "none" || chosen === index}
            data-negative={value < 0 || undefined}
          >
            <span className="rk-bar-label">{bar.label}</span>
            <span className="rk-bar-track">
              <span className="rk-bar-fill" style={{ width: `${(share * 100).toFixed(2)}%` }} />
            </span>
            <span className="rk-bar-value">
              {bar.display ??
                (finite(bar.value) ? formatValue(bar.value, undefined, undefined, words) : "")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

type PiePart = { label: ReactNode; value: number; display?: ReactNode };

const PIE_SIZE = 120;
const PIE_RING = 24;
/** The track shows between slices. */
const PIE_GAP = 2;
/** With many parts, slivers under 2% fold into one "Other" slice. */
const FOLD_OVER = 8;

/** A donut of parts of one whole, with each part's value and share listed beside it. */
export function Pie({
  parts = [],
  total,
  label,
}: {
  parts?: PiePart[];
  total?: boolean | ReactNode;
  label?: ReactNode;
}) {
  const words = useWords();
  const valid = (Array.isArray(parts) ? parts : []).filter(
    (part) => part && finite(part.value) && part.value > 0,
  );
  const sum = valid.reduce((acc, part) => acc + part.value, 0);
  let shown: PiePart[] = valid;
  if (valid.length > FOLD_OVER) {
    const small = valid.filter((part) => part.value / sum < 0.02);
    if (small.length > 1) {
      shown = [
        ...valid.filter((part) => part.value / sum >= 0.02),
        { label: words.t("other"), value: small.reduce((acc, part) => acc + part.value, 0) },
      ];
    }
  }
  // Parts too large to add up have no shares to draw.
  if (shown.length === 0 || !Number.isFinite(sum)) return null;
  const radius = (PIE_SIZE - PIE_RING) / 2;
  const circumference = 2 * Math.PI * radius;
  const largest = shown.reduce(
    (best, part, index) => (part.value > shown[best]!.value ? index : best),
    0,
  );
  let start = 0;
  const slices = shown.map((part, index) => {
    const share = part.value / sum;
    const slice = { part, share, start, color: seriesColor(index) };
    start += share;
    return slice;
  });
  const percent = (share: number) =>
    share < 0.01
      ? `<${words.number(0.01, { style: "percent" })}`
      : words.number(share, { style: "percent", maximumFractionDigits: 0 });
  const showTotal = total !== undefined && total !== false && total !== null;
  const totalText = total === true ? formatValue(sum, undefined, undefined, words) : total;
  const description = `${text(label) ? `${text(label)}: ` : ""}${slices
    .map(
      ({ part, share }) =>
        `${text(part.label)} ${text(part.display ?? part.value)}, ${percent(share)}`,
    )
    .join("; ")}`;
  return (
    <div className="rk-pie rk-frame">
      <div className="rk-pie-ring">
        <svg role="img" width={PIE_SIZE} height={PIE_SIZE} viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}>
          <title>{description}</title>
          <circle
            cx={PIE_SIZE / 2}
            cy={PIE_SIZE / 2}
            r={radius}
            fill="none"
            style={{ stroke: "var(--rk-fill-strong)" }}
            strokeWidth={PIE_RING}
          />
          {slices.map(({ part, share, start: from, color }, index) => (
            <circle
              key={index}
              className="rk-pie-slice"
              cx={PIE_SIZE / 2}
              cy={PIE_SIZE / 2}
              r={radius}
              fill="none"
              style={{ stroke: color }}
              strokeWidth={PIE_RING}
              strokeDasharray={`${Math.max(share * circumference - (slices.length > 1 ? PIE_GAP : 0), 0.5)} ${circumference}`}
              strokeDashoffset={-from * circumference}
              transform={`rotate(-90 ${PIE_SIZE / 2} ${PIE_SIZE / 2})`}
            >
              <title>{`${text(part.label)}: ${percent(share)}`}</title>
            </circle>
          ))}
        </svg>
        {showTotal ? (
          <div className="rk-pie-total" aria-hidden="true">
            <span className="rk-pie-total-figure">{totalText}</span>
            {label != null && label !== "" ? (
              <span className="rk-pie-total-label">{label}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <ul className="rk-pie-legend">
        {slices.map(({ part, share, color }, index) => (
          <li
            key={index}
            style={{ "--rk-swatch": color } as CSSProperties}
            data-emphasis={index === largest || undefined}
          >
            <span className="rk-pie-value">
              {part.display ?? formatValue(part.value, undefined, undefined, words)}
            </span>
            <span className="rk-pie-label">{part.label}</span>
            <span className="rk-pie-share">{percent(share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
