import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { TableSortDirection } from "./table-utils";

/** Every user-visible string the markdown renderer draws itself. */
export type MarkdownCopy = {
  /** Shared confirmation for every copy button. */
  copied: string;
  copyCode: string;
  copyDiagramSource: string;
  /** Scrollable regions and the expanded dialog's title. */
  table: string;
  markdownTable: string;
  /** Gutter column header. */
  row: string;
  noRows: string;
  previousPage: string;
  nextPage: string;
  copyRows: string;
  downloadCsv: string;
  expandTable: string;
  closeTable: string;
  sortCleared: string;
  pageOf: (page: number, count: number) => string;
  rowCount: (count: number) => string;
  rowRange: (from: number, to: number, total: number) => string;
  columnFallback: (index: number) => string;
  columnDuplicate: (header: string, index: number) => string;
  columnCollision: (label: string) => string;
  sortBy: (column: string) => string;
  sortedBy: (column: string, direction: TableSortDirection) => string;
};

export const defaultMarkdownCopy: MarkdownCopy = {
  copied: "Copied",
  copyCode: "Copy code",
  copyDiagramSource: "Copy diagram source",
  table: "Table",
  markdownTable: "Markdown table",
  row: "Row",
  noRows: "No rows",
  previousPage: "Previous page",
  nextPage: "Next page",
  copyRows: "Copy rows",
  downloadCsv: "Download CSV",
  expandTable: "Expand table",
  closeTable: "Close table",
  sortCleared: "Sort cleared",
  pageOf: (page, count) => `Page ${page} of ${count}`,
  rowCount: (count) => `${count} ${count === 1 ? "row" : "rows"}`,
  rowRange: (from, to, total) => `${from}–${to} of ${total} rows`,
  columnFallback: (index) => `column ${index}`,
  columnDuplicate: (header, index) => `${header}, column ${index}`,
  columnCollision: (label) => `${label}, empty`,
  sortBy: (column) => `Sort by ${column}`,
  sortedBy: (column, direction) =>
    `Sorted by ${column}, ${direction === "asc" ? "ascending" : "descending"}`,
};

const MarkdownCopyContext = createContext<MarkdownCopy>(defaultMarkdownCopy);

export function MarkdownCopyProvider({
  copy = defaultMarkdownCopy,
  children,
}: {
  copy?: MarkdownCopy;
  children: ReactNode;
}) {
  return <MarkdownCopyContext.Provider value={copy}>{children}</MarkdownCopyContext.Provider>;
}

export function useMarkdownCopy() {
  return useContext(MarkdownCopyContext);
}
