import type { CSSProperties, ReactNode } from "react";
import { isValidElement, useCallback, useContext, useState } from "react";
import { finite } from "./dataviz.js";
import { Inline } from "./inline.js";
import { objectItems } from "./items.js";
import { useWords } from "./labels.js";
import { InGrid } from "./layout.js";

export type Tone = "success" | "warning" | "danger" | "accent" | "info" | "neutral";

const TONES = new Set(["success", "warning", "danger", "accent", "info"]);

/** "info" is the accent under another name; anything unknown stays neutral. */
function toneClass(tone: unknown): string | undefined {
  if (typeof tone !== "string" || !TONES.has(tone)) return undefined;
  return `rk-tone-${tone === "info" ? "accent" : tone}`;
}

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export type Metric = {
  value: ReactNode;
  label: ReactNode;
  tone?: Tone;
  detail?: ReactNode;
  /** A change such as "+12%" or -3, drawn with an arrow coloured by whether it is good. */
  delta?: string | number;
  /** Which way is good for the delta: "up" (default) or "down", as for churn or cost. */
  better?: "up" | "down";
  /** A small trend line under the figure. */
  trend?: number[];
};

function deltaDirection(delta: string | number): 1 | -1 | 0 {
  if (typeof delta === "number") return delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const trimmed = delta.trim();
  if (/^[+\u2191\u25b2]/.test(trimmed)) return 1;
  if (/^[-\u2212\u2193\u25bc]/.test(trimmed)) return -1;
  return 0;
}

function Delta({ delta, better }: { delta: string | number; better?: "up" | "down" }) {
  const words = useWords();
  const direction = deltaDirection(delta);
  const good = direction === 0 ? undefined : direction > 0 === (better !== "down");
  const shown =
    typeof delta === "number"
      ? words.number(Math.abs(delta), { maximumFractionDigits: 2 })
      : delta.trim().replace(/^[+\-\u2212\u2191\u2193\u25b2\u25bc]\s*/, "");
  return (
    <span
      className={cx(
        "rk-delta",
        good === undefined ? undefined : good ? "rk-tone-success" : "rk-tone-danger",
      )}
    >
      {direction !== 0 ? (
        <svg className="rk-delta-arrow" viewBox="0 0 8 8" aria-hidden="true">
          <path d={direction > 0 ? "M4 1.2 7.2 6.6H.8Z" : "M4 6.8.8 1.4h6.4Z"} />
        </svg>
      ) : null}
      <span className="rk-visually-hidden">
        {direction > 0 ? `${words.t("up")} ` : direction < 0 ? `${words.t("down")} ` : ""}
      </span>
      {shown}
    </span>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const shown = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (shown.length < 2) return null;
  const low = Math.min(...shown);
  const high = Math.max(...shown);
  const span = high - low || 1;
  const points = shown
    .map(
      (v, i) =>
        `${((i / (shown.length - 1)) * 100).toFixed(2)},${(22 - ((v - low) / span) * 20).toFixed(2)}`,
    )
    .join(" ");
  return (
    <svg className="rk-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        className="rk-draw"
        pathLength={1}
        points={points}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const textOf = (node: unknown) =>
  typeof node === "string" || typeof node === "number" ? String(node) : "";

/** Headline figures, up to four a row; a row holds fewer when a figure is too wide to fit. */
export function Metrics({ metrics = [] }: { metrics?: Metric[] }) {
  const shown = objectItems(metrics);
  if (shown.length === 0) return null;
  const columns = Math.min(4, shown.length);
  const widest = Math.max(...shown.map((metric) => textOf(metric.value).length));
  return (
    <div
      className="rk-metrics"
      style={
        {
          "--rk-columns": columns,
          "--rk-metric-min": `${Math.max(7, Math.min(18, widest * 0.62 + 1))}rem`,
        } as CSSProperties
      }
    >
      {shown.map((metric, index) => (
        <div className="rk-metric" key={index}>
          <div className="rk-metric-value" title={textOf(metric.value) || undefined}>
            {metric.value}
          </div>
          <div className="rk-metric-label">{metric.label}</div>
          {finite(metric.delta) || (typeof metric.delta === "string" && metric.delta !== "") ? (
            <div className="rk-metric-detail">
              <Delta delta={metric.delta} better={metric.better} />
              {metric.detail != null && metric.detail !== "" ? (
                <span className="rk-metric-detail-note"> {metric.detail}</span>
              ) : null}
            </div>
          ) : metric.detail != null && metric.detail !== "" ? (
            <div className={cx("rk-metric-detail", toneClass(metric.tone))}>{metric.detail}</div>
          ) : null}
          {Array.isArray(metric.trend) ? <Sparkline values={metric.trend} /> : null}
        </div>
      ))}
    </div>
  );
}

/** A short status word in a tinted pill with a dot; long text ends in an ellipsis. */
export function Status({ tone, children }: { tone?: Tone; children?: ReactNode }) {
  if (children == null || children === "" || children === false) return null;
  return (
    <span
      className={cx("rk-status", toneClass(tone))}
      title={typeof children === "string" ? children : undefined}
    >
      <span className="rk-status-dot" aria-hidden="true" />
      <span className="rk-status-text">{children}</span>
    </span>
  );
}

type StatusLabel = { label: ReactNode; tone?: Tone };

type Property = { label: ReactNode; value: ReactNode };

export function Properties({ items = [] }: { items?: Property[] }) {
  const card = useContext(InGrid);
  return (
    <dl className="rk-properties" data-card={card || undefined}>
      {objectItems(items).map((item, index) => (
        <div className="rk-property" key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export type Row = {
  title: ReactNode;
  lead?: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
  status?: StatusLabel;
};

const present = (node: unknown) => node != null && node !== "" && node !== false;

/** A hairline-separated list: optional lead, the title with its status, detail, and meta. */
export function Rows({ rows = [] }: { rows?: Row[] }) {
  const shown = objectItems(rows);
  if (shown.length === 0) return null;
  const leads = shown.some((row) => present(row.lead));
  return (
    <ul className="rk-rows" data-leads={leads || undefined}>
      {shown.map((row, index) => {
        const status =
          row.status && typeof row.status === "object" && !isValidElement(row.status)
            ? row.status
            : undefined;
        return (
          <li className="rk-row" key={index}>
            {leads ? <span className="rk-row-lead">{row.lead}</span> : null}
            <div className="rk-row-main">
              <div className="rk-row-title">
                {row.title}
                {status && present(status.label) ? (
                  <span className={cx("rk-row-status", toneClass(status.tone))}>
                    {" \u00b7 "}
                    {status.label}
                  </span>
                ) : null}
              </div>
              {present(row.detail) ? (
                <div className="rk-row-detail">
                  <Inline>{row.detail}</Inline>
                </div>
              ) : null}
            </div>
            {present(row.meta) ? <span className="rk-row-meta">{row.meta}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export type Step = { title: ReactNode; detail?: ReactNode };

export function Steps({ steps = [] }: { steps?: Step[] }) {
  return (
    <ol className="rk-steps">
      {objectItems(steps).map((step, index) => (
        <li className="rk-step" key={index}>
          <span className="rk-step-number" aria-hidden="true">
            {index + 1}
          </span>
          <div>
            <div className="rk-step-title">{step.title}</div>
            {step.detail != null && step.detail !== "" ? (
              <div className="rk-step-detail">
                <Inline>{step.detail}</Inline>
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

type ChecklistItem = { text: ReactNode; done?: boolean; meta?: ReactNode };

export function Checklist({ items = [] }: { items?: ChecklistItem[] }) {
  return (
    <ul className="rk-checklist">
      {objectItems(items).map((item, index) => (
        <li key={index}>
          {/* Read-only: it shows recorded progress, the reader cannot tick it. */}
          <label className="rk-check" data-done={item.done === true}>
            <input type="checkbox" disabled checked={item.done === true} />
            <svg className="rk-check-mark" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="9" />
              {item.done === true ? <path d="M6 10.4l2.6 2.6L14 7.6" /> : null}
            </svg>
            <span className="rk-check-text">
              <Inline>{item.text}</Inline>
            </span>
          </label>
          {item.meta != null && item.meta !== "" ? (
            <div className="rk-check-meta">{item.meta}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export type TableCell =
  | string
  | number
  | null
  | undefined
  | ReactNode
  | { text: ReactNode; tone?: Tone };

function cellContent(cell: TableCell): ReactNode {
  if (cell === null || typeof cell !== "object" || isValidElement(cell) || Array.isArray(cell)) {
    return cell as ReactNode;
  }
  if (!("text" in cell)) return null;
  const tone = toneClass(cell.tone);
  return tone ? <span className={tone}>{cell.text}</span> : cell.text;
}

// Amounts written as text ("$1,200", "4.8%", "12k") read as figures too.
const FIGURE = /^[-+\u2212\u00b1]?[$\u20ac\u00a3\u00a5\u20b9]?\d[\d,.]*(%|[kKMB])?$/;

/** A single word or a time, up to this long, lines up with the figures. */
const SHORT_WORD = 16;
const TIME =
  /\d:\d\d|\d ?(?:h|min|d|w)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d/i;

function isFigure(cell: TableCell): boolean {
  // A toned cell ({text, tone}) is still a figure when its text is one.
  const value = cell && typeof cell === "object" && "text" in cell ? cell.text : cell;
  return typeof value === "number" || (typeof value === "string" && FIGURE.test(value.trim()));
}

type Align = "start" | "end" | "center" | "auto";
const ALIGNS = new Set(["start", "end", "center"]);

/** Past this many rows a table offers a filter and keeps its header in view. */
const LONG_TABLE = 15;
/** Rows drawn at first; the rest arrive with "Show more" so huge tables stay quick. */
const PAGE_ROWS = 200;

function cellText(cell: TableCell): string {
  if (Array.isArray(cell)) return cell.map((item) => cellText(item)).join("");
  if (typeof cell === "string" || typeof cell === "number") return String(cell);
  if (cell && typeof cell === "object" && !isValidElement(cell) && "text" in cell) {
    return cellText(cell.text as TableCell);
  }
  if (isValidElement(cell)) {
    const children = (cell.props as { children?: unknown }).children;
    return cellText(children as TableCell);
  }
  return "";
}

/** "$1,200", "-4.5%" and "12k" sort as the numbers they show. */
function sortKey(cell: TableCell): number | string {
  if (typeof cell === "number") return cell;
  const raw = cellText(cell).trim();
  if (FIGURE.test(raw)) {
    const scale = /k$/i.test(raw) ? 1e3 : /M$/.test(raw) ? 1e6 : /B$/.test(raw) ? 1e9 : 1;
    const number = Number.parseFloat(raw.replace(/[^\d.\-\u2212]/g, "").replace("\u2212", "-"));
    if (Number.isFinite(number)) return number * scale;
  }
  return raw.toLowerCase();
}

/** Fades the edge a wide table can still scroll towards. */
function useScrollEdges(direction: string) {
  const [edges, setEdges] = useState({ start: false, end: false });
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const update = () => {
        const max = Math.max(0, element.scrollWidth - element.clientWidth);
        // The mask fades physical left/right edges. RTL offsets run from -max to zero.
        const left = Math.min(
          max,
          Math.max(
            0,
            element.scrollLeft + (getComputedStyle(element).direction === "rtl" ? max : 0),
          ),
        );
        const start = left > 1;
        const end = left < max - 1;
        setEdges((old) => (old.start === start && old.end === end ? old : { start, end }));
      };
      update();
      element.addEventListener("scroll", update, { passive: true });
      const observer =
        typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
      observer?.observe(element);
      return () => {
        element.removeEventListener("scroll", update);
        observer?.disconnect();
      };
    },
    [direction],
  );
  return { ref, edges };
}

export function Table({
  columns = [],
  rows = [],
  align,
  emphasis,
  sortable = false,
}: {
  columns?: ReactNode[];
  rows?: TableCell[][];
  align?: Align[];
  emphasis?: number;
  sortable?: boolean;
}) {
  const words = useWords();
  const heads = Array.isArray(columns) ? columns : [];
  const body = (Array.isArray(rows) ? rows : []).filter((row): row is TableCell[] =>
    Array.isArray(row),
  );
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_ROWS);
  const scroll = useScrollEdges(words.dir);
  if (heads.length === 0 && body.length === 0) return null;
  const width = Math.max(heads.length, ...body.map((row) => row.length));
  const indexes = Array.from({ length: width }, (_, index) => index);
  // Unless told otherwise, the first column is the row's label and reads from the start, as do
  // status and other rich cells; figures and short values beside them line up at the end.
  const aligns = indexes.map((index) => {
    const chosen = align?.[index];
    if (chosen && ALIGNS.has(chosen)) return chosen === "start" ? undefined : chosen;
    if (body.length === 0) return undefined;
    const cells = body.map((row) => row[index]);
    if (
      cells.every((cell) => cell == null || cell === "" || isFigure(cell)) &&
      cells.some(isFigure)
    ) {
      return "end";
    }
    // Single short words (plan names, codes) and short times or dates ("Daily 07:00", "Every
    // 4 h", "Oct 30") read as values; phrases read as prose and status pills stay put.
    const value = (cell: TableCell) => {
      if (typeof cell !== "string" && !(isValidElement(cell) && cell.type !== Status)) return false;
      const raw = cellText(cell).trim();
      return raw.length > 0 && raw.length <= SHORT_WORD && (!/\s/.test(raw) || TIME.test(raw));
    };
    const blank = (cell: TableCell) => cell == null || cell === "";
    return index > 0 && cells.some(value) && cells.every((cell) => blank(cell) || value(cell))
      ? "end"
      : undefined;
  });
  const long = body.length > LONG_TABLE;
  const needle = query.trim().toLowerCase();
  let shown = body.map((row, index) => ({ row, index }));
  if (needle) {
    shown = shown.filter(({ row }) =>
      row.some((cell) => cellText(cell).toLowerCase().includes(needle)),
    );
  }
  if (sort) {
    const direction = sort.descending ? -1 : 1;
    shown = [...shown].sort((a, b) => {
      const x = sortKey(a.row[sort.column]);
      const y = sortKey(b.row[sort.column]);
      if (typeof x === "number" && typeof y === "number") return (x - y) * direction;
      // Figures come before words, and after them when the order is reversed.
      if (typeof x === "number") return -direction;
      if (typeof y === "number") return direction;
      return x.localeCompare(y) * direction || a.index - b.index;
    });
  }
  const total = shown.length;
  const visible = shown.slice(0, limit);
  const cellClass = (index: number) =>
    cx(aligns[index] && `rk-align-${aligns[index]}`, emphasis === index && "rk-emphasis") ||
    undefined;
  const press = (column: number) =>
    setSort((old) =>
      old?.column !== column
        ? { column, descending: false }
        : old.descending
          ? null
          : { column, descending: true },
    );
  return (
    <div className="rk-table-wrap">
      {long || query ? (
        <input
          className="rk-table-filter"
          type="search"
          value={query}
          placeholder={words.t("filterRows")}
          aria-label={words.t("filterRows")}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setLimit(PAGE_ROWS);
          }}
        />
      ) : null}
      <div className="rk-table-box">
        <div
          className="rk-table-scroll"
          ref={scroll.ref}
          data-long={long || undefined}
          data-fade-start={scroll.edges.start || undefined}
          data-fade-end={scroll.edges.end || undefined}
          // Keyboard users can scroll a wide table once it has focus.
          tabIndex={width >= 5 ? 0 : undefined}
        >
          <table className="rk-table" data-wide={width >= 5 || undefined}>
            <thead>
              <tr>
                {indexes.map((index) => {
                  const column = heads[index];
                  const sorted = sort?.column === index;
                  return (
                    <th
                      key={index}
                      scope="col"
                      className={aligns[index] ? `rk-align-${aligns[index]}` : undefined}
                      aria-sort={
                        sorted ? (sort.descending ? "descending" : "ascending") : undefined
                      }
                    >
                      {sortable ? (
                        <button type="button" className="rk-sort" onClick={() => press(index)}>
                          {column}
                          <span
                            className="rk-sort-mark"
                            aria-hidden="true"
                            data-on={sorted || undefined}
                          >
                            {sorted && sort.descending ? "\u2193" : "\u2191"}
                          </span>
                        </button>
                      ) : (
                        column
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map(({ row, index: rowIndex }) => (
                <tr key={rowIndex}>
                  {indexes.map((index) => (
                    <td key={index} className={cellClass(index)}>
                      {cellContent(row[index])}
                    </td>
                  ))}
                </tr>
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td className="rk-table-none" colSpan={width}>
                    {words.t("noRowsMatch")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      {total > visible.length ? (
        <div className="rk-table-more">
          <span>{words.t("showing", { shown: visible.length, total })}</span>
          <button type="button" onClick={() => setLimit((old) => old + PAGE_ROWS)}>
            {words.t("showMore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export type SegmentedOption =
  | string
  | { value: string; label?: ReactNode; count?: number | string };

/** More options than this is a list, not tabs; the chosen one is always kept. */
const SEGMENTED_MAX = 200;

export function Segmented({
  options = [],
  value,
  onChange,
}: {
  options?: SegmentedOption[];
  value?: string;
  onChange?: (value: string) => void;
}) {
  type Item = { value: string; label: ReactNode; count?: number | string };
  const items = (Array.isArray(options) ? options : []).flatMap((option): Item[] =>
    typeof option === "string" || typeof option === "number"
      ? [{ value: String(option), label: String(option) }]
      : option && typeof option === "object" && "value" in option
        ? [{ ...option, value: String(option.value), label: option.label ?? String(option.value) }]
        : [],
  );
  const shown = items.slice(0, SEGMENTED_MAX);
  const chosen = items.findIndex((item) => item.value === value);
  if (chosen >= SEGMENTED_MAX) shown[SEGMENTED_MAX - 1] = items[chosen]!;
  return (
    <fieldset className="rk-segmented">
      {shown.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          onClick={() => onChange?.(item.value)}
        >
          <span className="rk-segment">
            {item.label}
            {item.count !== undefined && item.count !== null && item.count !== "" ? (
              <span className="rk-segment-count">{item.count}</span>
            ) : null}
          </span>
        </button>
      ))}
    </fieldset>
  );
}
