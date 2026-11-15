import type { ReactNode } from "react";
import { useWords } from "../labels.js";
import { describe, finite, seriesColor, text, textWidth, useWidth } from "./shared.js";
import { EmptyChart } from "./status.js";

type VennSet = { label: ReactNode; count?: number; items?: ReactNode[] };

/** Words in lines no wider than `max`, measured as the chart's labels are. */
function wrapWords(words: string, max: number): string[] {
  const lines: string[] = [];
  for (const word of words.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && textWidth(`${last} ${word}`) <= max) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines;
}

/** Two or three overlapping sets, each named outside its circle, with the shared figure inside. */
export function Venn({ sets = [], overlap }: { sets?: VennSet[]; overlap?: ReactNode }) {
  const words = useWords();
  const { ref, width } = useWidth(560);
  const shown = (Array.isArray(sets) ? sets : [])
    .filter((set) => set && set.label != null)
    .slice(0, 3);
  if (shown.length === 0) return <EmptyChart />;
  const r = Math.max(40, Math.min(79, (width - 160) / 3.2));
  const center = width / 2;
  const three = shown.length === 3;
  const dx = shown.length === 1 ? 0 : r * 0.754;
  const height = three ? Math.round(r * 3.16) : Math.round(r * 2 + 20);
  const cy = 10 + r;
  const circles = [
    { cx: center - dx, cy },
    { cx: center + dx, cy },
    { cx: center, cy: cy + r * 0.98 },
  ].slice(0, shown.length);
  const middle = three ? { x: center, y: (cy * 2 + cy + r * 0.98) / 3 } : { x: center, y: cy };
  const count = (set: VennSet) =>
    finite(set.count) ? set.count : Array.isArray(set.items) ? set.items.length : undefined;
  return (
    <div className="rk-chart rk-frame rk-venn" ref={ref}>
      <svg
        role="img"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-label={describe([
          ...shown.map(
            (set) =>
              `${text(set.label)}${count(set) !== undefined ? ` ${words.number(count(set)!)}` : ""}`,
          ),
          overlap != null ? words.t("shared", { value: text(overlap) }) : "",
        ])}
      >
        {circles.map((c, i) => (
          <circle
            key={i}
            className="rk-venn-set"
            cx={c.cx}
            cy={c.cy}
            r={r}
            style={{ fill: seriesColor(i), stroke: seriesColor(i) }}
          />
        ))}
        {circles.map((c, i) => {
          const set = shown[i]!;
          const leftSide = i === 0;
          const x = leftSide ? c.cx - r - 8 : c.cx + r * (i === 2 ? 0.55 : 1) + 8;
          const yText = i === 2 ? c.cy + r * 0.75 : c.cy - r * 0.5;
          const anchor = leftSide ? "end" : "start";
          return (
            <g key={`l${i}`}>
              <text className="rk-venn-name" x={x} y={yText} textAnchor={anchor}>
                {text(set.label)}
              </text>
              {count(set) !== undefined ? (
                <text className="rk-venn-count" x={x} y={yText + 16} textAnchor={anchor}>
                  {words.number(count(set)!)}
                </text>
              ) : null}
            </g>
          );
        })}
        {overlap != null && overlap !== "" && shown.length > 1
          ? (() => {
              // Wrapped to the shared middle, so a long note stays between the circles.
              const lines = wrapWords(text(overlap), Math.max(56, r * 1.1)).slice(0, 3);
              return (
                <text
                  className="rk-venn-overlap"
                  x={middle.x}
                  y={middle.y - ((lines.length - 1) * 15) / 2}
                  textAnchor="middle"
                >
                  {lines.map((line, index) => (
                    <tspan key={index} x={middle.x} dy={index === 0 ? "0.35em" : 15}>
                      {line}
                    </tspan>
                  ))}
                </text>
              );
            })()
          : null}
      </svg>
    </div>
  );
}

/** A small drawn arrow pointing to the high end of an axis. */
function Arrow() {
  return (
    <svg className="rk-axis-arrow" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 5h7.5M5.5 2l3 3-3 3" />
    </svg>
  );
}

type MatrixPoint = { label: ReactNode; x: number; y: number };

const axisEnds = (axis: unknown): [string, string] => {
  if (Array.isArray(axis)) return [text(axis[0]), text(axis[1])];
  return ["", text(axis)];
};

/** Four quadrants on two axes from low to high, with items placed by their 0 to 1 position. */
export function Matrix2x2({
  axes,
  quadrants = [],
  points = [],
}: {
  axes?: { x?: string | [string, string]; y?: string | [string, string] };
  quadrants?: ReactNode[];
  points?: MatrixPoint[];
}) {
  const words = useWords();
  const [xLow, xHigh] = axisEnds(axes?.x);
  const [yLow, yHigh] = axisEnds(axes?.y);
  const names = Array.isArray(quadrants) ? quadrants.slice(0, 4) : [];
  const shown = (Array.isArray(points) ? points : []).filter(
    (p) => p && finite(p.x) && finite(p.y),
  );
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const percent = (v: number) => Math.round(v * 10_000) / 100;
  return (
    <div className="rk-matrix rk-frame">
      <div className="rk-matrix-y" aria-hidden="true">
        <span>{yLow}</span>
        <span>
          {yHigh}
          {yHigh ? <Arrow /> : null}
        </span>
      </div>
      <div className="rk-matrix-body">
        <div
          className="rk-matrix-plot"
          role="img"
          aria-label={describe([
            words.t("matrixAxes", { x: xHigh || "x", y: yHigh || "y" }),
            ...names.map(
              (name, i) =>
                `${words.t((["topLeft", "topRight", "bottomLeft", "bottomRight"] as const)[i]!)}: ${text(name)}`,
            ),
            ...shown.map((p) =>
              words.t("pointAt", {
                label: text(p.label),
                x: words.number(clamp(p.x), { style: "percent", maximumFractionDigits: 0 }),
                y: words.number(clamp(p.y), { style: "percent", maximumFractionDigits: 0 }),
              }),
            ),
          ])}
        >
          {names.map((name, i) => (
            <span key={i} className="rk-matrix-quadrant" data-corner={i} title={text(name)}>
              {name}
            </span>
          ))}
          {shown.map((p, i) => (
            <span
              key={`p${i}`}
              className="rk-matrix-point"
              data-flip={clamp(p.x) > 0.75 || undefined}
              style={{ left: `${percent(clamp(p.x))}%`, top: `${percent(1 - clamp(p.y))}%` }}
            >
              <span className="rk-matrix-dot" />
              <span className="rk-matrix-label" title={text(p.label)}>
                {p.label}
              </span>
            </span>
          ))}
        </div>
        <div className="rk-matrix-x" aria-hidden="true">
          <span>{xLow}</span>
          <span>
            {xHigh}
            {xHigh ? <Arrow /> : null}
          </span>
        </div>
      </div>
    </div>
  );
}
