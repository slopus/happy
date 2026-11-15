import type { ReactNode } from "react";
import { useWords } from "../labels.js";
import type { Formatter } from "./shared.js";
import {
  axisGutter,
  ChartTip,
  describe,
  finite,
  formatValue,
  PLOT,
  SeriesLegend,
  seriesColor,
  text,
  textWidth,
  thinLabels,
  useActive,
  useWidth,
  ValueGrid,
  valueScale,
} from "./shared.js";
import { EmptyChart } from "./status.js";

/** A rounded-top column path; `round` is the corner radius, `flat` keeps the bottom square. */
function columnPath(
  x: number,
  top: number,
  width: number,
  bottom: number,
  round: number,
  flat = true,
) {
  const r = Math.max(0, Math.min(round, width / 2, (bottom - top) / 2));
  const b = flat ? 0 : r;
  return (
    `M${x + r} ${top}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${top + r}` +
    `V${bottom - b}A${b} ${b} 0 0 1 ${x + width - b} ${bottom}H${x + b}` +
    `A${b} ${b} 0 0 1 ${x} ${bottom - b}V${top + r}A${r} ${r} 0 0 1 ${x + r} ${top}Z`
  );
}

type ColumnPoint = { label?: ReactNode; value: number; display?: ReactNode };

/** Vertical columns with their value on top; the largest is inked and the rest recede. */
export function Columns({
  points = [],
  emphasis,
}: {
  points?: ColumnPoint[];
  emphasis?: number | "none";
}) {
  const words = useWords();
  const { ref, width } = useWidth(560);
  const shown = (Array.isArray(points) ? points : []).filter((point) => finite(point?.value));
  const gap = 8;
  const slot = (width - gap * Math.max(0, shown.length - 1)) / Math.max(1, shown.length);
  const hover = useActive(shown.length, (x) =>
    shown.length ? Math.min(shown.length - 1, Math.max(0, Math.floor(x / (slot + gap)))) : null,
  );
  if (shown.length === 0) return <EmptyChart />;
  const values = shown.map((point) => point.value);
  const max = Math.max(0, ...values);
  const chosen = emphasis === undefined ? values.indexOf(max) : emphasis;
  const column = Math.max(2, Math.min(28, slot * 0.7));
  const baseline = PLOT.height - PLOT.bottom;
  const tallest = baseline - 20;
  const labelWidth = Math.max(...shown.map((point) => textWidth(text(point.label)) + 6));
  const labelled = new Set(thinLabels(shown.length, width, Math.max(labelWidth, slot), 40));
  const valueRoom = slot >= Math.max(...shown.map((p) => textWidth(text(p.display ?? p.value))));
  const center = (index: number) => index * (slot + gap) + slot / 2;
  const heightOf = (v: number) => (max > 0 && v > 0 ? (v / max) * tallest : 0);
  const active = hover.active;
  return (
    <div className="rk-chart rk-frame" ref={ref}>
      <div className="rk-plot">
        <svg
          role="img"
          className="rk-focus-ring"
          width={width}
          height={PLOT.height}
          viewBox={`0 0 ${width} ${PLOT.height}`}
          {...hover.props}
        >
          <title>
            {describe(
              shown.map((point) => `${text(point.label)}: ${text(point.display ?? point.value)}`),
            )}
          </title>
          {max === 0 && values.every((value) => value === 0) ? (
            // Nothing rises, so the baseline and a note keep the chart from reading as broken.
            <>
              <line className="rk-grid-line" x1={0} x2={width} y1={baseline} y2={baseline} />
              <text className="rk-column-value" x={width / 2} y={baseline / 2} textAnchor="middle">
                {words.t("allZero")}
              </text>
            </>
          ) : null}
          {shown.map((point, index) => {
            const inked = chosen === "none" || chosen === index;
            const height = heightOf(point.value);
            const top = baseline - height;
            return (
              <g
                key={index}
                data-emphasis={inked || undefined}
                data-dim={active !== null && active !== index ? true : undefined}
              >
                {height > 0 ? (
                  <path
                    className="rk-column"
                    d={columnPath(center(index) - column / 2, top, column, baseline, 6)}
                    style={{
                      fill: inked ? "var(--rk-c1)" : "var(--rk-rest)",
                    }}
                  />
                ) : null}
                {valueRoom || inked ? (
                  <text
                    className="rk-column-value"
                    x={center(index)}
                    y={top - 6}
                    textAnchor="middle"
                  >
                    {point.display ?? point.value}
                  </text>
                ) : null}
                {labelled.has(index) ? (
                  <text
                    className="rk-tick rk-column-label"
                    x={center(index)}
                    y={PLOT.height - 4}
                    textAnchor="middle"
                  >
                    {point.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        <ChartTip
          width={width}
          tip={
            active === null
              ? null
              : {
                  x: center(active),
                  y: baseline - heightOf(shown[active]!.value) - 4,
                  title: shown[active]!.label,
                  rows: [
                    {
                      value:
                        shown[active]!.display ??
                        formatValue(shown[active]!.value, undefined, undefined, words),
                    },
                  ],
                }
          }
        />
      </div>
    </div>
  );
}

export type Series = { name: ReactNode; values: number[] };

/** Several series per label, side by side or stacked, with an optional reference line. */
export function ColumnSeries({
  labels = [],
  series = [],
  stacked = false,
  ceiling,
  unit,
  format,
  reference,
  legend = true,
}: {
  labels?: ReactNode[];
  series?: Series[];
  stacked?: boolean;
  ceiling?: number;
  unit?: string;
  format?: Formatter;
  reference?: { value: number; label?: ReactNode };
  legend?: boolean;
}) {
  const words = useWords();
  const { ref, width } = useWidth(560);
  const rows = (Array.isArray(series) ? series : []).filter(
    (item) => item && Array.isArray(item.values),
  );
  const names = Array.isArray(labels) ? labels : [];
  const count = Math.max(names.length, ...rows.map((item) => item.values.length), 0);
  const value = (item: Series, index: number) => {
    const v = item.values[index];
    return finite(v) && v > 0 ? v : 0;
  };
  const totals = Array.from({ length: count }, (_, index) =>
    stacked
      ? rows.reduce((sum, item) => sum + value(item, index), 0)
      : Math.max(0, ...rows.map((item) => value(item, index))),
  );
  const referenceValue = reference && finite(reference.value) ? reference.value : undefined;
  const scale = valueScale(
    [...totals, ...(referenceValue === undefined ? [] : [referenceValue])],
    0,
    ceiling,
  );
  const label = (tick: number) => formatValue(tick, unit, format, words);
  const left = axisGutter(scale.ticks.map(label));
  // The reference label sits above its line, so a long one never squeezes the columns.
  const right = width - PLOT.right;
  const slot = (right - left) / Math.max(1, count);
  const hover = useActive(count, (x) =>
    x < left || x > right ? null : Math.min(count - 1, Math.floor((x - left) / slot)),
  );
  if (rows.length === 0 || count === 0 || !totals.some((total) => total > 0)) return <EmptyChart />;
  const top = PLOT.top;
  const baseline = PLOT.height - PLOT.bottom;
  const y = (v: number) =>
    baseline -
    ((Math.min(scale.high, Math.max(scale.low, v)) - scale.low) / (scale.high - scale.low)) *
      (baseline - top);
  // The gap narrows with the slot, so many labels never leave a column less than nothing.
  const gap = Math.min(2, (slot * 0.62) / (4 * rows.length));
  const group = stacked
    ? Math.min(28, slot * 0.62)
    : Math.min(slot * 0.62, rows.length * 28 + (rows.length - 1) * gap);
  const bar = stacked ? group : (group - gap * (rows.length - 1)) / rows.length;
  const labelWidth = Math.max(...names.map((name) => textWidth(text(name)) + 8), 1);
  const labelled = new Set(thinLabels(count, right - left, Math.max(labelWidth, slot), 40));
  const active = hover.active;
  const description = describe(
    Array.from(
      { length: count },
      (_, index) =>
        `${text(names[index])}: ${rows.map((item) => `${text(item.name)} ${label(value(item, index))}`).join(", ")}`,
    ),
  );
  return (
    <div className="rk-chart rk-frame" ref={ref}>
      {legend !== false && rows.length > 1 ? (
        <SeriesLegend
          items={rows.map((item, index) => ({
            name: item.name,
            color: seriesColor(index),
            mark: stacked ? "dot" : "line",
          }))}
        />
      ) : null}
      <div className="rk-plot">
        <svg
          role="img"
          className="rk-focus-ring"
          width={width}
          height={PLOT.height}
          viewBox={`0 0 ${width} ${PLOT.height}`}
          {...hover.props}
        >
          <title>{description}</title>
          <ValueGrid ticks={scale.ticks} y={y} left={left} right={right} label={label} />
          {Array.from({ length: count }, (_, index) => {
            const start = left + index * slot + (slot - group) / 2;
            let sum = 0;
            return (
              <g key={index} data-dim={active !== null && active !== index ? true : undefined}>
                {rows.map((item, seriesIndex) => {
                  const v = value(item, index);
                  if (v <= 0) return null;
                  const style = {
                    fill: seriesColor(seriesIndex),
                  };
                  if (stacked) {
                    const bottom = y(sum) - (sum > 0 ? gap : 0);
                    sum += v;
                    const topEdge = y(sum);
                    if (bottom - topEdge < 0.5) return null;
                    return (
                      <path
                        key={seriesIndex}
                        d={columnPath(start, topEdge, bar, bottom, 2, bottom >= baseline)}
                        style={style}
                      />
                    );
                  }
                  return (
                    <path
                      key={seriesIndex}
                      d={columnPath(start + seriesIndex * (bar + gap), y(v), bar, baseline, 6)}
                      style={style}
                    />
                  );
                })}
                {labelled.has(index) ? (
                  <text
                    className="rk-tick"
                    x={left + index * slot + slot / 2}
                    y={PLOT.height - 4}
                    textAnchor="middle"
                  >
                    {names[index]}
                  </text>
                ) : null}
              </g>
            );
          })}
          {referenceValue !== undefined ? (
            <ReferenceLine
              y={y(referenceValue)}
              left={left}
              right={right}
              end={right}
              label={reference?.label}
              above
            />
          ) : null}
        </svg>
        <ChartTip
          width={width}
          tip={
            active === null
              ? null
              : {
                  x: left + active * slot + slot / 2,
                  y: y(totals[active]!) - 4,
                  title: names[active],
                  rows: [
                    ...rows.map((item, i) => ({
                      name: item.name,
                      value: label(value(item, active)),
                      color: seriesColor(i),
                    })),
                    ...(stacked && rows.length > 1
                      ? [{ name: words.t("total"), value: label(totals[active]!) }]
                      : []),
                  ],
                }
          }
        />
      </div>
    </div>
  );
}

/** A dashed level across the plot, named at its right end. */
export function ReferenceLine({
  y,
  left,
  right,
  end,
  label,
  above = false,
}: {
  y: number;
  left: number;
  right: number;
  end: number;
  label?: ReactNode;
  /** The label sits on the line's right end, above it, instead of in a gutter after it. */
  above?: boolean;
}) {
  return (
    <g className="rk-reference">
      <line x1={left} x2={right} y1={y} y2={y} className="rk-reference-line" />
      {label != null && label !== "" ? (
        <text
          className="rk-reference-label"
          x={end}
          y={above ? y - 6 : y}
          dy={above ? undefined : "0.35em"}
          textAnchor="end"
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

type StackedBar = { label: ReactNode; values: number[]; display?: ReactNode };

/** One horizontal bar per row, split into named segments, with the row total after it. */
export function StackedBars({
  series = [],
  bars = [],
}: {
  series?: ReactNode[];
  bars?: StackedBar[];
}) {
  const words = useWords();
  const names = Array.isArray(series) ? series : [];
  const rows = (Array.isArray(bars) ? bars : []).filter((bar) => bar && Array.isArray(bar.values));
  const parts = (bar: StackedBar) => bar.values.map((v) => (finite(v) && v > 0 ? v : 0));
  const totals = rows.map((bar) => parts(bar).reduce((sum, v) => sum + v, 0));
  const max = Math.max(0, ...totals);
  // Parts whose total overflows draw nothing rather than NaN widths.
  if (rows.length === 0 || max <= 0 || !finite(max)) return <EmptyChart />;
  return (
    <div className="rk-chart rk-frame">
      {names.length > 1 ? (
        <SeriesLegend
          small
          items={names.map((name, index) => ({ name, color: seriesColor(index) }))}
        />
      ) : null}
      <div
        className="rk-stacked"
        role="img"
        aria-label={describe(
          rows.map(
            (bar) =>
              `${text(bar.label)}: ${parts(bar)
                .map(
                  (v, i) => `${text(names[i]) || words.t("part", { n: i + 1 })} ${words.number(v)}`,
                )
                .join(", ")}`,
          ),
        )}
      >
        {rows.map((bar, index) => (
          <div className="rk-stacked-row" key={index}>
            <span className="rk-stacked-label">{bar.label}</span>
            <span className="rk-stacked-track">
              <span
                className="rk-stacked-bar"
                style={{ width: `calc((100% - 4.5rem) * ${(totals[index]! / max).toFixed(4)})` }}
              >
                {parts(bar).map((v, i) =>
                  v > 0 ? (
                    <span
                      key={i}
                      className="rk-stacked-part"
                      style={{ flexGrow: v, background: seriesColor(i) }}
                    />
                  ) : null,
                )}
              </span>
              <span className="rk-stacked-value">{bar.display ?? totals[index]}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
