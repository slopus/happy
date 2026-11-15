import { droppedTableHtmlText } from "@rakazo/contracts";
import type { MarkdownCopy } from "./markdown-copy";
import { defaultMarkdownCopy } from "./markdown-copy";

/** Structural hast subset — avoids a direct @types/hast dependency. */
export interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  /** Source offsets supplied by the markdown parser, when available. */
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: HastNode[];
}

export type TableAlign = "left" | "center" | "right" | null;

export type ExtractedTable = {
  columns: string[];
  aligns: TableAlign[];
  rows: string[][];
  /** Identity of columns+aligns; a schema change resets card interaction state. */
  schemaKey: string;
  /** Identity of all extracted content; anything derived keys on this, not refs. */
  dataSignature: string;
  numericColumns: ReadonlySet<number>;
  minWidths: Record<number, string>;
  /** Content-derived React keys; stable across re-parses and sort order. */
  rowKeys: Map<string[], string>;
};

export type TableSortDirection = "asc" | "desc";

export const TABLE_PAGE_SIZE = 10;

/** First tr's header cells become columns; later trs become rows. */
export function extractTable(node: HastNode | undefined): ExtractedTable | null {
  if (!node) return null;
  const trs = collectRows(node);
  const [headerRow, ...bodyRows] = trs;
  if (!headerRow) return null;
  const headerCells = cellsOf(headerRow, "th");
  const header = headerCells.length > 0 ? headerCells : cellsOf(headerRow, "td");
  if (header.length === 0) return null;
  const columns = header.map((cell) => textOf(cell).trim());
  const aligns = header.map((cell) => alignOf(cell));
  const rows = bodyRows.map((row) => {
    const cells = cellsOf(row, "td");
    const source = cells.length > 0 ? cells : cellsOf(row, "th");
    return columns.map((_, i) => textOf(source[i]).trim());
  });
  // Everything downstream derives from the same walk: signatures let renders
  // skip re-deriving identical content when a stream re-parses the tree.
  const numericColumns = new Set<number>();
  columns.forEach((_, i) => {
    if (isNumericColumn(rows, i)) numericColumns.add(i);
  });
  const occurrences = new Map<string, number>();
  const rowKeys = new Map(
    rows.map((row) => {
      const signature = JSON.stringify(row);
      const occurrence = occurrences.get(signature) ?? 0;
      occurrences.set(signature, occurrence + 1);
      return [row, `${signature}:${occurrence}`] as const;
    }),
  );
  return {
    columns,
    aligns,
    rows,
    schemaKey: JSON.stringify([columns, aligns]),
    dataSignature: JSON.stringify([columns, rows]),
    numericColumns,
    minWidths: columnMinWidths(columns, rows),
    rowKeys,
  };
}

function collectRows(node: HastNode): HastNode[] {
  const rows: HastNode[] = [];
  const walk = (current: HastNode) => {
    for (const child of childrenOf(current)) {
      if (child.tagName === "tr") rows.push(child);
      else walk(child);
    }
  };
  walk(node);
  return rows;
}

function childrenOf(node: HastNode): HastNode[] {
  return Array.isArray(node.children) ? node.children : [];
}

function cellsOf(row: HastNode, tag: "th" | "td"): HastNode[] {
  return childrenOf(row).filter((child) => child.tagName === tag);
}

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  // Preserve text equivalents when this helper receives raw table HTML.
  if (node.type === "raw") {
    return droppedTableHtmlText(node.value ?? "") ?? "";
  }
  if (node.tagName === "br") return " ";
  if (node.tagName === "img") {
    const alt = node.properties?.alt;
    return typeof alt === "string" ? alt : "";
  }
  return childrenOf(node).map(textOf).join("");
}

function alignOf(cell: HastNode): TableAlign {
  const align = cell.properties?.align;
  return align === "left" || align === "center" || align === "right" ? align : null;
}

/**
 * Numeric parse tolerant of thousands separators, currency, percent and
 * accounting-style "(123)" negatives. Empty/whitespace is not numeric.
 */
export function parseNumericText(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed
    .replace(/^\((.*)\)$/, "$1")
    .replace(/[$€£%\s]/g, "")
    .replace(/\u2212/g, "-");
  if (!/^[+-]?((\d{1,3}(,\d{3})+|\d+)(\.\d+)?|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(n) ? (negative ? -Math.abs(n) : n) : null;
}

/** True when every non-empty cell in the column parses as a number. */
export function isNumericColumn(rows: string[][], columnIndex: number): boolean {
  let seen = false;
  for (const row of rows) {
    const value = row[columnIndex] ?? "";
    if (value === "") continue;
    if (parseNumericText(value) === null) return false;
    seen = true;
  }
  return seen;
}

/** Accessible sort label: empty → position; duplicates / collisions append position. */
export function columnSortLabel(
  columns: string[],
  index: number,
  copy: Pick<
    MarkdownCopy,
    "columnFallback" | "columnDuplicate" | "columnCollision"
  > = defaultMarkdownCopy,
): string {
  const column = columns[index] ?? "";
  if (column && columns.indexOf(column) === columns.lastIndexOf(column)) return column;
  let label = column ? copy.columnDuplicate(column, index + 1) : copy.columnFallback(index + 1);
  // A literal header can claim a generated name, including its disambiguation.
  while (columns.includes(label)) label = copy.columnCollision(label);
  return label;
}

/** Compare non-empty cells: numeric when both parse, else text. */
export function compareCellText(a: string, b: string): number {
  const an = parseNumericText(a);
  const bn = parseNumericText(b);
  if (an !== null && bn !== null) return an - bn;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Stable sort on one column; empty cells always sink to the bottom. */
export function sortRows(
  rows: string[][],
  columnIndex: number,
  direction: TableSortDirection,
): string[][] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[columnIndex] ?? "";
    const bv = b[columnIndex] ?? "";
    if (av === "" && bv === "") return 0;
    if (av === "") return 1;
    if (bv === "") return -1;
    return factor * compareCellText(av, bv);
  });
}

/** Next sort state: none → asc → desc → none; switching columns restarts at asc. */
export function nextSort(
  current: { column: number; direction: TableSortDirection } | null,
  column: number,
): { column: number; direction: TableSortDirection } | null {
  if (!current || current.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

// Matches the .rk-table-cell-text max-width so min-width never outgrows it.
const MAX_WIDTH_CHARS = 60;

/** ch-based min-width per column from the longest cell, capped. */
export function columnMinWidths(columns: string[], rows: string[][]): Record<number, string> {
  const widths: Record<number, string> = {};
  columns.forEach((column, i) => {
    let maxChars = column.length;
    for (const row of rows) {
      const chars = (row[i] ?? "").length;
      if (chars > maxChars) maxChars = chars;
    }
    widths[i] = `calc(${Math.min(maxChars, MAX_WIDTH_CHARS)}ch + 1.5rem)`;
  });
  return widths;
}

// Leading = + - @ after any whitespace would be evaluated as a formula by
// spreadsheet apps; prefix a quote so exports stay inert.
const FORMULA_PREFIX = /^\s*[=+\-@]/;
const neutralizeFormula = (value: string) => (FORMULA_PREFIX.test(value) ? `'${value}` : value);

export function tableToCsv(columns: string[], rows: string[][]): string {
  const cell = (value: string) => {
    const safe = neutralizeFormula(value);
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const line = (cells: string[]) => cells.map(cell).join(",");
  return [line(columns), ...rows.map((row) => line(columns.map((_, i) => row[i] ?? "")))].join(
    "\n",
  );
}

export function tableToTsv(columns: string[], rows: string[][]): string {
  const clean = (value: string) => {
    const safe = neutralizeFormula(value).replace(/[\t\r\n]/g, " ");
    return safe.includes('"') ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const line = (cells: string[]) => cells.map(clean).join("\t");
  return [line(columns), ...rows.map((row) => line(columns.map((_, i) => row[i] ?? "")))].join(
    "\n",
  );
}
