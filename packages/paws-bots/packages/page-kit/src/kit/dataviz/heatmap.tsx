import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useRef, useState } from "react";
import { parseDay } from "../calendar.js";
import { useWords } from "../labels.js";
import { ChartTip, describe, finite, formatValue, numbers, text, useWidth } from "./shared.js";
import { EmptyChart } from "./status.js";

const SHADES = 5;

/** Which of the five ramp steps a value falls in; nothing for zero or no value. */
export function shade(value: unknown, max: number): number | undefined {
  if (!finite(value) || value <= 0 || !(max > 0)) return undefined;
  return Math.min(SHADES, Math.max(1, Math.ceil((value / max) * SHADES)));
}

const shadeColor = (step: number | undefined) =>
  step ? `var(--rk-seq${step})` : "var(--rk-fill-strong)";

function Ramp({ low, high }: { low: string; high: string }) {
  return (
    <div className="rk-ramp" aria-hidden="true">
      <span>{low}</span>
      {Array.from({ length: SHADES }, (_, i) => (
        <span key={i} className="rk-ramp-step" style={{ background: shadeColor(i + 1) }} />
      ))}
      <span>{high}</span>
    </div>
  );
}

/** Where a cell sits inside its chart, for placing the tip over it. */
function cellTip(target: EventTarget | null, host: HTMLElement | null) {
  if (!(target instanceof HTMLElement) || !host || !target.dataset.cell) return null;
  const box = target.getBoundingClientRect();
  const frame = host.getBoundingClientRect();
  return {
    key: target.dataset.cell,
    x: box.left - frame.left + box.width / 2,
    y: box.top - frame.top,
  };
}

type CellFocus = { key: string; x: number; y: number } | null;

/** Hovering or arrowing through cells shows that cell's exact figure. */
function useCells(keys: string[]) {
  const host = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<CellFocus>(null);
  const place = (key: string) => {
    const element = host.current?.querySelector<HTMLElement>(`[data-cell="${key}"]`);
    setFocus(element ? cellTip(element, host.current) : null);
  };
  const props = {
    tabIndex: keys.length ? 0 : undefined,
    onPointerOver: (event: PointerEvent<HTMLElement>) =>
      setFocus(cellTip(event.target, host.current)),
    onPointerLeave: () => setFocus(null),
    onBlur: () => setFocus(null),
    onKeyDown: (event: KeyboardEvent<HTMLElement>, step: Record<string, number>) => {
      const index = focus ? keys.indexOf(focus.key) : -1;
      const move = event.key === "Escape" ? null : step[event.key];
      if (event.key === "Escape") setFocus(null);
      if (move === undefined || move === null) return;
      event.preventDefault();
      const next = Math.min(keys.length - 1, Math.max(0, index < 0 ? 0 : index + move));
      place(keys[next]!);
    },
  };
  return { host, focus, props };
}

/** A grid of rows by columns, each cell shaded by its value on one sequential ramp. */
const HEAT_LABEL = 24;

export function Heatmap({
  rows = [],
  columns = [],
  values = [],
  max,
}: {
  rows?: ReactNode[];
  columns?: ReactNode[];
  values?: number[][];
  max?: number;
}) {
  const words = useWords();
  const rowNames = Array.isArray(rows) ? rows : [];
  const columnNames = Array.isArray(columns) ? columns : [];
  const grid = Array.isArray(values) ? values : [];
  const cell = (r: number, c: number) => {
    const row = grid[r];
    return Array.isArray(row) ? row[c] : undefined;
  };
  const keys = rowNames.flatMap((_, r) => columnNames.map((_, c) => `${r}-${c}`));
  const cells = useCells(keys);
  const fit = useWidth(10_000);
  // Cells shrink to fit a phone; a column label then shows only every few columns, about one
  // per HEAT_LABEL pixels after the row names.
  const step = Math.max(
    1,
    Math.ceil((HEAT_LABEL * columnNames.length) / Math.max(1, fit.width - 48)),
  );
  const all = grid.flatMap((row) => numbers(row));
  const top = finite(max) && max > 0 ? max : Math.max(0, ...all);
  if (rowNames.length === 0 || columnNames.length === 0 || all.length === 0) return <EmptyChart />;
  const focus = cells.focus;
  const [fr, fc] = focus ? focus.key.split("-").map(Number) : [];
  const figure = (v: unknown) =>
    finite(v) ? formatValue(v, undefined, undefined, words) : words.t("noValue");
  return (
    <div className="rk-chart rk-frame" ref={cells.host}>
      <Ramp low={words.t("fewer")} high={words.t("rampMore")} />
      <div className="rk-heatmap-scroll" ref={fit.ref}>
        <div
          className="rk-heatmap rk-focus-ring"
          data-thin={step > 1 || undefined}
          role="img"
          aria-label={describe(
            rowNames.map(
              (row, r) =>
                `${text(row)}: ${columnNames.map((col, c) => `${text(col)} ${figure(cell(r, c))}`).join(", ")}`,
            ),
          )}
          style={{ "--rk-heat-columns": columnNames.length } as CSSProperties}
          {...cells.props}
          onKeyDown={(event) =>
            cells.props.onKeyDown(event, {
              ArrowRight: 1,
              ArrowLeft: -1,
              ArrowDown: columnNames.length,
              ArrowUp: -columnNames.length,
            })
          }
        >
          <span aria-hidden="true" />
          {columnNames.map((name, c) => (
            <span key={`c${c}`} className="rk-heatmap-column" title={text(name)}>
              {c % step === 0 ? name : null}
            </span>
          ))}
          {rowNames.map((name, r) => [
            <span key={`r${r}`} className="rk-heatmap-row" title={text(name)}>
              {name}
            </span>,
            ...columnNames.map((_, c) => (
              <span
                key={`${r}-${c}`}
                data-cell={`${r}-${c}`}
                data-active={focus?.key === `${r}-${c}` || undefined}
                className="rk-heatmap-cell"
                style={{ background: shadeColor(shade(cell(r, c), top)) }}
              />
            )),
          ])}
        </div>
      </div>
      <ChartTip
        width={cells.host.current?.clientWidth ?? 10_000}
        tip={
          focus && fr !== undefined && fc !== undefined
            ? {
                x: focus.x,
                y: focus.y,
                title: `${text(rowNames[fr])} · ${text(columnNames[fc])}`,
                rows: [{ value: figure(cell(fr, fc)) }],
              }
            : null
        }
      />
    </div>
  );
}

const DAY = 86_400_000;

const utcDay = (value: unknown) => parseDay(value)?.getTime();

/** A year-at-a-glance strip of days in week columns, Monday first, shaded by value. */
export function CalendarHeatmap({
  days = [],
  from,
  to,
  max,
  note,
}: {
  days?: { date: string; value: number }[];
  from?: string;
  to?: string;
  max?: number;
  note?: ReactNode;
}) {
  const words = useWords();
  const byDay = new Map<number, number>();
  for (const day of Array.isArray(days) ? days : []) {
    const time = utcDay(day?.date);
    if (time !== undefined && finite(day.value))
      byDay.set(time, (byDay.get(time) ?? 0) + day.value);
  }
  const known = [...byDay.keys()];
  const startGuess = utcDay(from) ?? (known.length ? Math.min(...known) : 0);
  const endGuess = Math.min(
    utcDay(to) ?? (known.length ? Math.max(...known) : 0),
    startGuess + 550 * DAY,
  );
  const keys: string[] = [];
  for (let time = startGuess; time <= endGuess && keys.length <= 551; time += DAY) {
    keys.push(new Date(time).toISOString().slice(0, 10));
  }
  const cellsFocus = useCells(keys);
  const start = utcDay(from) ?? (known.length ? Math.min(...known) : undefined);
  const end = utcDay(to) ?? (known.length ? Math.max(...known) : undefined);
  if (start === undefined || end === undefined || end < start || known.length === 0)
    return <EmptyChart />;
  // At most about a year and a half, so a stray far date cannot draw thousands of cells.
  const last = Math.min(end, start + 550 * DAY);
  const top = finite(max) && max > 0 ? max : Math.max(0, ...byDay.values());
  const weekday = (time: number) => (new Date(time).getUTCDay() + 6) % 7;
  const firstWeek = start - weekday(start) * DAY;
  const weeks = Math.floor((last - firstWeek) / DAY / 7) + 1;
  const cells: ReactNode[] = [];
  const months: ReactNode[] = [];
  let lastMonth = -1;
  let labelWeek = Number.NEGATIVE_INFINITY;
  for (let time = start; time <= last; time += DAY) {
    const date = new Date(time);
    const week = Math.floor((time - firstWeek) / DAY / 7);
    const value = byDay.get(time);
    const iso = date.toISOString().slice(0, 10);
    cells.push(
      <span
        key={iso}
        className="rk-day"
        data-cell={iso}
        data-active={cellsFocus.focus?.key === iso || undefined}
        style={{
          gridColumn: week + 2,
          gridRow: weekday(time) + 2,
          background: shadeColor(shade(value, top)),
        }}
      />,
    );
    if (date.getUTCMonth() !== lastMonth && (date.getUTCDate() <= 7 || time === start)) {
      lastMonth = date.getUTCMonth();
      // A range starting late in a month leaves its first label no room: the next one wins.
      if (week - labelWeek < 3) months.pop();
      labelWeek = week;
      months.push(
        <span
          key={`m${iso}`}
          className="rk-calendar-month"
          style={{ gridColumn: `${week + 2} / span 4`, gridRow: 1 }}
        >
          {words.date(time, { month: "short", timeZone: "UTC" })}
        </span>,
      );
    }
  }
  return (
    <div className="rk-calendar rk-frame" ref={cellsFocus.host}>
      <div className="rk-calendar-scroll">
        <div
          className="rk-calendar-grid rk-focus-ring"
          role="img"
          {...cellsFocus.props}
          onKeyDown={(event) =>
            cellsFocus.props.onKeyDown(event, {
              ArrowRight: 7,
              ArrowLeft: -7,
              ArrowDown: 1,
              ArrowUp: -1,
            })
          }
          aria-label={words.t("dailyValues", {
            from: words.date(start, { dateStyle: "medium", timeZone: "UTC" }),
            to: words.date(last, { dateStyle: "medium", timeZone: "UTC" }),
            top,
          })}
          style={{ "--rk-weeks": weeks } as CSSProperties}
        >
          {months}
          {[1, 3, 5]
            .map((day) => words.date(Date.UTC(2024, 0, day), { weekday: "short", timeZone: "UTC" }))
            .map((name, i) => (
              <span
                key={name}
                className="rk-calendar-weekday"
                style={{ gridColumn: 1, gridRow: i * 2 + 2 }}
              >
                {name}
              </span>
            ))}
          {cells}
        </div>
      </div>
      <div className="rk-calendar-foot">
        {note != null && note !== "" ? <span className="rk-calendar-note">{note}</span> : <span />}
        <Ramp low={words.t("less")} high={words.t("rampMore")} />
      </div>
      <ChartTip
        width={cellsFocus.host.current?.clientWidth ?? 10_000}
        tip={
          cellsFocus.focus
            ? {
                x: cellsFocus.focus.x,
                y: cellsFocus.focus.y,
                title: words.date(Date.parse(`${cellsFocus.focus.key}T00:00:00Z`), {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                }),
                rows: [
                  {
                    value: formatValue(
                      byDay.get(utcDay(cellsFocus.focus.key) ?? 0) ?? 0,
                      undefined,
                      undefined,
                      words,
                    ),
                  },
                ],
              }
            : null
        }
      />
    </div>
  );
}
