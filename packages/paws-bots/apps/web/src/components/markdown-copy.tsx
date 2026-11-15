import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MarkdownCopy } from "@rakazo/chat-ui/web";
import { MarkdownCopyProvider } from "@rakazo/chat-ui/web";
import type { ReactNode } from "react";
import { useMemo } from "react";

/** Translated strings for the table card and code/diagram copy buttons markdown draws. */
export function MarkdownChrome({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const copy = useMemo<MarkdownCopy>(
    () => ({
      copied: t`Copied`,
      copyCode: t`Copy code`,
      copyDiagramSource: t`Copy diagram source`,
      table: t`Table`,
      markdownTable: t`Markdown table`,
      row: t`Row`,
      noRows: t`No rows`,
      previousPage: t`Previous page`,
      nextPage: t`Next page`,
      copyRows: t`Copy rows`,
      downloadCsv: t`Download CSV`,
      expandTable: t`Expand table`,
      closeTable: t`Close table`,
      sortCleared: t`Sort cleared`,
      pageOf: (page, count) => t`Page ${page} of ${count}`,
      rowCount: (count) => t`${plural(count, { one: "# row", other: "# rows" })}`,
      rowRange: (from, to, total) => t`${from}–${to} of ${total} rows`,
      columnFallback: (index) => t`column ${index}`,
      columnDuplicate: (header, index) => t`${header}, column ${index}`,
      columnCollision: (label) => t`${label}, empty`,
      sortBy: (column) => t`Sort by ${column}`,
      sortedBy: (column, direction) =>
        direction === "asc"
          ? t`Sorted by ${column}, ascending`
          : t`Sorted by ${column}, descending`,
    }),
    [t],
  );
  return <MarkdownCopyProvider copy={copy}>{children}</MarkdownCopyProvider>;
}
