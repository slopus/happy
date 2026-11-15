import { typeScale } from "@rakazo/ui-tokens";
import type { ASTNode } from "@ronradtke/react-native-markdown-display";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { View } from "react-native";
import { cellPlainText } from "./ast";
import { SidewaysScrollView } from "./sideways-scroll";

const TABLE_FONT_SIZE = typeScale.caption.fontSize;
const TABLE_CELL_GUTTER = 16;
const TABLE_MIN_COLUMN_WIDTH = 64;
const TABLE_MAX_COLUMN_WIDTH = 220;

const TableColumnWidthsContext = createContext<readonly number[]>([]);

function glyphEm(char: string) {
  if (char === " " || char === "\n" || char === "\t") return 0.33;
  if ("ilj.,'|:;!".includes(char)) return 0.35;
  if ("mwMW@#%&".includes(char)) return 0.95;
  if (char >= "A" && char <= "Z") return 0.72;
  if (char >= "0" && char <= "9") return 0.62;
  return 0.6;
}

function estimateTextWidth(text: string, bold: boolean) {
  const scale = bold ? 1.08 : 1;
  let width = 0;
  for (const char of text) width += glyphEm(char) * TABLE_FONT_SIZE * scale;
  return width * 1.15;
}

function columnWidthForText(text: string, bold: boolean) {
  const trimmed = text.trim();
  const content = estimateTextWidth(trimmed, bold);
  const longestWord = trimmed.split(/\s+/).reduce((max, word) => {
    return Math.max(max, estimateTextWidth(word, bold));
  }, 0);
  const needed = Math.max(
    content,
    Math.min(longestWord, TABLE_MAX_COLUMN_WIDTH - TABLE_CELL_GUTTER),
  );
  return Math.min(
    TABLE_MAX_COLUMN_WIDTH,
    Math.max(TABLE_MIN_COLUMN_WIDTH, Math.ceil(needed + TABLE_CELL_GUTTER)),
  );
}

function tableRows(table: ASTNode) {
  const rows: ASTNode[] = [];
  for (const section of table.children) {
    if (section.type === "thead" || section.type === "tbody") {
      for (const row of section.children) {
        if (row.type === "tr") rows.push(row);
      }
    } else if (section.type === "tr") {
      rows.push(section);
    }
  }
  return rows;
}

function contentColumnWidths(table: ASTNode) {
  const rows = tableRows(table);
  const count = rows.reduce((max, row) => Math.max(max, row.children.length), 0);
  const widths = Array.from({ length: count }, () => TABLE_MIN_COLUMN_WIDTH);
  for (const row of rows) {
    row.children.forEach((cell, index) => {
      widths[index] = Math.max(
        widths[index] ?? TABLE_MIN_COLUMN_WIDTH,
        columnWidthForText(cellPlainText(cell), cell.type === "th"),
      );
    });
  }
  return widths;
}

function fittedColumnWidths(table: ASTNode, viewportWidth: number) {
  const widths = contentColumnWidths(table);
  if (widths.length === 0 || viewportWidth <= 0) return widths;
  const sum = widths.reduce((total, width) => total + width, 0);
  if (sum >= viewportWidth) return widths;
  const extra = Math.floor((viewportWidth - sum) / widths.length);
  const fitted = widths.map((width) => width + extra);
  const used = fitted.reduce((total, width) => total + width, 0);
  const last = fitted.length - 1;
  fitted[last] = (fitted[last] ?? 0) + (viewportWidth - used);
  return fitted;
}

function columnStyle(width: number) {
  return {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "auto" as const,
    width,
    minWidth: width,
    maxWidth: width,
  };
}

export function TableCell({
  columnIndex,
  baseStyle,
  children,
}: {
  columnIndex: number;
  baseStyle: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const widths = useContext(TableColumnWidthsContext);
  const width = widths[columnIndex] ?? TABLE_MIN_COLUMN_WIDTH;
  return <View style={[baseStyle, columnStyle(width)]}>{children}</View>;
}

export function TableRow({
  baseStyle,
  children,
}: {
  baseStyle: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const widths = useContext(TableColumnWidthsContext);
  const rowWidth = widths.reduce((total, width) => total + width, 0);
  return (
    <View style={[baseStyle, { width: rowWidth, minWidth: rowWidth, flexShrink: 0 }]}>
      {children}
    </View>
  );
}

export function TableScrollView({
  table,
  children,
  style,
}: {
  table: ASTNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const [viewportWidth, setViewportWidth] = useState(0);
  const widths = useMemo(() => fittedColumnWidths(table, viewportWidth), [table, viewportWidth]);
  return (
    <TableColumnWidthsContext.Provider value={widths}>
      <SidewaysScrollView
        contentWidth={widths.reduce((total, width) => total + width, 0)}
        onViewportWidth={setViewportWidth}
        style={style}
      >
        {children}
      </SidewaysScrollView>
    </TableColumnWidthsContext.Provider>
  );
}
