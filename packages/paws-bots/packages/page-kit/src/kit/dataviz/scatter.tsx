import type { ReactNode } from "react";
import { useWords } from "../labels.js";
import type { Formatter } from "./shared.js";
import {
  axisGutter,
  ChartTip,
  describe,
  finite,
  formatValue,
  niceStep,
  SeriesLegend,
  seriesColor,
  text,
  useActive,
  useWidth,
  ValueGrid,
} from "./shared.js";
import { EmptyChart } from "./status.js";

type ScatterPoint = {
  x: number;
  y: number;
  size?: number;
  label?: ReactNode;
  series?: string;
};
type ScatterAxis = {
  name?: string;
  unit?: string;
  format?: Formatter;
  floor?: number;
  ceiling?: number;
};

function axisRange(values: number[], axis: ScatterAxis | undefined, count: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const low0 = finite(axis?.floor)
    ? axis.floor
    : Math.min(0, min) === 0 && min > 0 && min < max / 2
      ? 0
      : min;
  const high0 = finite(axis?.ceiling) ? axis.ceiling : max;
  const step = niceStep(low0, high0 > low0 ? high0 : low0 + 1, count);
  const low = finite(axis?.floor) ? axis.floor : Math.floor(low0 / step) * step;
  const high = finite(axis?.ceiling)
    ? axis.ceiling
    : Math.ceil((high0 > low0 ? high0 : low0 + 1) / step) * step;
  const ticks: number[] = [];
  for (let tick = low; tick <= high + step / 1e6 && ticks.length < 12; tick += step)
    ticks.push(Number(tick.toFixed(10)));
  return { low, high: high > low ? high : low + 1, ticks };
}

/** Dots on two value axes, coloured by series and sized by a third figure, with a trend line. */
export function Scatter({
  points = [],
  x,
  y,
  size,
  trend = false,
  legend = true,
}: {
  points?: ScatterPoint[];
  x?: ScatterAxis;
  y?: ScatterAxis;
  size?: { name?: string };
  trend?: boolean;
  legend?: boolean;
}) {
  const words = useWords();
  const { ref, width } = useWidth(560);
  const shown = (Array.isArray(points) ? points : []).filter(
    (p) => p && finite(p.x) && finite(p.y),
  );
  const height = 196;
  const top = 10;
  const bottom = height - 26;
  const xs = axisRange(shown.length ? shown.map((p) => p.x) : [0], x, 4);
  const ys = axisRange(shown.length ? shown.map((p) => p.y) : [0], y, 4);
  const yLabel = (v: number) => formatValue(v, y?.unit, y?.format, words);
  const xLabel = (v: number) => formatValue(v, x?.unit, x?.format, words);
  const left = axisGutter(ys.ticks.map(yLabel));
  const right = width - 12;
  const px = (v: number) => left + ((v - xs.low) / (xs.high - xs.low)) * (right - left);
  const py = (v: number) => bottom - ((v - ys.low) / (ys.high - ys.low)) * (bottom - top);
  const hover = useActive(shown.length, (mx, my) => {
    let best: number | null = null;
    let distance = 24 * 24;
    shown.forEach((p, index) => {
      const d = (px(p.x) - mx) ** 2 + (py(p.y) - my) ** 2;
      if (d < distance) {
        distance = d;
        best = index;
      }
    });
    return best;
  });
  if (shown.length === 0) return <EmptyChart />;
  const groups = [...new Set(shown.map((p) => (typeof p.series === "string" ? p.series : "")))];
  const colorOf = (p: ScatterPoint) =>
    seriesColor(Math.max(0, groups.indexOf(typeof p.series === "string" ? p.series : "")));
  const biggest = Math.max(0, ...shown.map((p) => (finite(p.size) && p.size > 0 ? p.size : 0)));
  const radius = (p: ScatterPoint) =>
    biggest > 0 && finite(p.size) && p.size > 0 ? Math.max(3, 8 * Math.sqrt(p.size / biggest)) : 3;
  // Least squares through every dot, clipped to the plot; dots far off it get their label.
  let fit: [number, number, number, number] | null = null;
  const outliers = new Set<number>();
  if (trend && shown.length > 1) {
    const n = shown.length;
    const mx = shown.reduce((sum, p) => sum + p.x, 0) / n;
    const my = shown.reduce((sum, p) => sum + p.y, 0) / n;
    const sxx = shown.reduce((sum, p) => sum + (p.x - mx) ** 2, 0);
    if (sxx > 0) {
      const slope = shown.reduce((sum, p) => sum + (p.x - mx) * (p.y - my), 0) / sxx;
      const at = (v: number) => my + slope * (v - mx);
      const clip = (v: number) => (slope === 0 ? v : mx + (v - my) / slope);
      let x1 = Math.min(...shown.map((p) => p.x));
      let x2 = Math.max(...shown.map((p) => p.x));
      if (at(x1) < ys.low) x1 = clip(ys.low);
      if (at(x1) > ys.high) x1 = clip(ys.high);
      if (at(x2) > ys.high) x2 = clip(ys.high);
      if (at(x2) < ys.low) x2 = clip(ys.low);
      fit = [px(x1), py(at(x1)), px(x2), py(at(x2))];
      const residuals = shown.map((p) => p.y - at(p.x));
      const spread = Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / n);
      residuals.forEach((r, index) => {
        if (spread > 0 && Math.abs(r) > 1.8 * spread && shown[index]!.label != null) {
          outliers.add(index);
        }
      });
    }
  }
  const order = shown
    .map((_, index) => index)
    .sort((a, b) => radius(shown[b]!) - radius(shown[a]!));
  const xTicks = xs.ticks.length > 6 ? xs.ticks.filter((_, i) => i % 2 === 0) : xs.ticks;
  const active = hover.active;
  const activePoint = active === null ? undefined : shown[active];
  return (
    <div className="rk-chart rk-frame" ref={ref}>
      {legend !== false && groups.length > 1 ? (
        <SeriesLegend
          items={groups.map((name, index) => ({
            name: name || words.t("other"),
            color: seriesColor(index),
          }))}
        />
      ) : null}
      <div className="rk-plot">
        <svg
          role="img"
          className="rk-focus-ring"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          {...hover.props}
        >
          <title>
            {describe([
              words.t(size?.name ? "againstSized" : "against", {
                x: x?.name ?? "x",
                y: y?.name ?? "y",
                size: size?.name ?? "",
              }),
              ...shown.map(
                (p) =>
                  `${text(p.label) || text(p.series)} ${xLabel(p.x)}, ${yLabel(p.y)}${finite(p.size) ? `, ${p.size}` : ""}`,
              ),
            ])}
          </title>
          <ValueGrid ticks={ys.ticks} y={py} left={left} right={width} label={yLabel} />
          {xTicks.map((tick, index) => (
            <text
              key={index}
              className="rk-tick"
              x={px(tick)}
              y={height - 4}
              textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}
            >
              {xLabel(tick)}
            </text>
          ))}
          {fit ? (
            <line className="rk-trend" x1={fit[0]} y1={fit[1]} x2={fit[2]} y2={fit[3]} />
          ) : null}
          {order.map((index) => {
            const p = shown[index]!;
            return (
              <circle
                key={index}
                className="rk-dot"
                cx={px(p.x)}
                cy={py(p.y)}
                r={radius(p) + (active === index ? 1.5 : 0)}
                data-dim={active !== null && active !== index ? true : undefined}
                style={{ fill: colorOf(p) }}
              />
            );
          })}
          {[...outliers].map((index) => {
            const p = shown[index]!;
            const flip = px(p.x) > width * 0.75;
            return (
              <text
                key={`o${index}`}
                className="rk-outlier"
                x={px(p.x) + (flip ? -1 : 1) * (radius(p) + 4)}
                y={py(p.y)}
                dy="0.35em"
                textAnchor={flip ? "end" : "start"}
              >
                {text(p.label)}
              </text>
            );
          })}
        </svg>
        <ChartTip
          width={width}
          tip={
            activePoint
              ? {
                  x: px(activePoint.x),
                  y: py(activePoint.y) - radius(activePoint) - 2,
                  title: activePoint.label ?? activePoint.series,
                  rows: [
                    { name: x?.name ?? "x", value: xLabel(activePoint.x) },
                    { name: y?.name ?? "y", value: yLabel(activePoint.y) },
                    ...(finite(activePoint.size)
                      ? [
                          {
                            name: size?.name ?? words.t("size"),
                            value: formatValue(activePoint.size, undefined, undefined, words),
                          },
                        ]
                      : []),
                  ],
                }
              : null
          }
        />
      </div>
    </div>
  );
}
