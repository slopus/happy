import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import type {
  ASTNode,
  createMarkdownIt,
  RenderRules,
} from "@ronradtke/react-native-markdown-display";
import type { ReactNode } from "react";
import type { TextStyle } from "react-native";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { cellPlainText } from "./ast";
import { contraryDirection } from "./direction";
import { layout, MARKER_COLUMN } from "./styles";

// Advances at the list-number size (15 pt): a tabular digit, and the "." or ")" after it.
const NUMBER_DIGIT_WIDTH = 9.6;
const NUMBER_MARK_WIDTH = { ".": 4.1, ")": 5.6 };

/**
 * Wide enough for the list's longest number at the current text size, so every item's text
 * starts at the same place.
 */
function numberColumnWidth(list: ASTNode, markup: string, fontScale: number) {
  const start = Number(list.attributes?.start);
  const last = (Number.isFinite(start) ? start : 1) + list.children.length - 1;
  const digits = String(Math.max(1, last)).length;
  const mark = markup === ")" ? NUMBER_MARK_WIDTH[")"] : NUMBER_MARK_WIDTH["."];
  return Math.max(MARKER_COLUMN, Math.ceil((digits * NUMBER_DIGIT_WIDTH + mark) * fontScale));
}
const ZERO_WIDTH_SPACE = "\u200B";
const TASK_MARKER = /^\[([ xX])\]\s+/;
// The first text token ends at a line break, so its marker may have nothing after it.
const TASK_MARKER_TOKEN = /^\[([ xX])\](?:\s+|$)/;

/** The parts of a markdown-it token the task list rule reads and writes. */
type ParsedToken = {
  type: string;
  content: string;
  children: ParsedToken[] | null;
  attrSet(name: string, value: string): void;
};

/**
 * GitHub task lists, as web renders them: a list item starting `[ ]` or `[x]` loses that text
 * and carries its state, so the list item rule draws a checkbox instead.
 */
export function markTaskListItems(parser: ReturnType<typeof createMarkdownIt>) {
  parser.core.ruler.after("inline", "task_list_items", (state: { tokens: ParsedToken[] }) => {
    const tokens = state.tokens;
    for (let index = 2; index < tokens.length; index += 1) {
      const inline = tokens[index];
      const item = tokens[index - 2];
      if (
        inline?.type !== "inline" ||
        tokens[index - 1]?.type !== "paragraph_open" ||
        item?.type !== "list_item_open"
      )
        continue;
      const first = inline.children?.[0];
      // Read the source, so an escaped `\[x\]` stays literal text.
      const match = TASK_MARKER.exec(inline.content);
      const token = first?.type === "text" ? TASK_MARKER_TOKEN.exec(first.content) : null;
      if (!first || !match || !token) continue;
      first.content = first.content.slice(token[0].length);
      // A marker alone on its line leaves the break that followed it leading the text.
      if (!first.content && inline.children?.[1]?.type === "softbreak") {
        inline.children.splice(1, 1);
      }
      inline.content = inline.content.replace(TASK_MARKER, "");
      item.attrSet("data-task", match[1] === " " ? "open" : "done");
    }
  });
}

type RenderRule = NonNullable<RenderRules["link"]>;

/** One column width per list, with the number against the text, so item text lines up past 9. */
function NumberColumn({
  list,
  markup,
  reversed,
  children,
}: {
  list: ASTNode;
  markup: string;
  reversed: boolean;
  children: ReactNode;
}) {
  // The number grows with the iOS text size up to the app's limit, so its column does too.
  const fontScale = Math.min(useWindowDimensions().fontScale, MAX_FONT_SCALE);
  return (
    <View
      style={[
        { minWidth: numberColumnWidth(list, markup, fontScale) },
        reversed ? layout.numberAfter : layout.numberBefore,
      ]}
    >
      {children}
    </View>
  );
}

// Automatic basis: `flex: 1` is zero-width and collapses a shrink-wrapped list bubble.
export function listItemRule(
  node: Parameters<RenderRule>[0],
  children: ReactNode[],
  parent: Parameters<RenderRule>[2],
  styleMap: Parameters<RenderRule>[3],
): ReactNode {
  const body = StyleSheet.flatten(styleMap.body) as TextStyle | undefined;
  // An item written against the app's direction puts its marker on the far side, read its way.
  const direction = contraryDirection(cellPlainText(node));
  const row = [styleMap._VIEW_SAFE_list_item, direction && layout.reversedRow];
  const marker: TextStyle = {
    color: body?.color,
    fontSize: body?.fontSize,
    lineHeight: body?.lineHeight,
    writingDirection: direction,
  };
  // `parent` lists ancestors nearest first; the nearest list decides the marker, so an ordered
  // list nested in a bulleted one is numbered.
  const list = parent.find(
    (ancestor) => ancestor.type === "bullet_list" || ancestor.type === "ordered_list",
  );
  const task = node.attributes?.["data-task"];
  if (task === "open" || task === "done") {
    const color =
      (StyleSheet.flatten(styleMap.bullet_list_icon) as TextStyle | undefined)?.color ??
      body?.color;
    // VoiceOver reads the item as one checkbox with its state. An item holding a nested list
    // makes only its box the checkbox, so each nested item keeps its own.
    const nested = node.children.some(
      (child) => child.type === "bullet_list" || child.type === "ordered_list",
    );
    const checkbox = {
      accessible: true,
      accessibilityRole: "checkbox" as const,
      accessibilityLabel: cellPlainText(nested ? (node.children[0] ?? node) : node).trim(),
      accessibilityState: { checked: task === "done" },
    };
    return (
      <View key={node.key} style={row} {...(nested ? {} : checkbox)}>
        <View
          style={[layout.bulletMarker, direction ? layout.taskAfter : layout.taskBefore]}
          {...(nested ? checkbox : {})}
        >
          <Text style={marker} accessible={false} importantForAccessibility="no">
            {ZERO_WIDTH_SPACE}
          </Text>
          <View style={[layout.taskBox, { borderColor: color }]}>
            {task === "done" ? (
              <Text style={[layout.taskCheck, { color }]} accessible={false}>
                ✓
              </Text>
            ) : null}
          </View>
        </View>
        <View style={layout.listContent}>{children}</View>
      </View>
    );
  }
  if (list?.type === "bullet_list") {
    // A dot in the list-marker colour, centred on the item's first line, at the end of the marker
    // column. The invisible character gives the marker that line's height at the current text size.
    const dotColor = (StyleSheet.flatten(styleMap.bullet_list_icon) as TextStyle | undefined)
      ?.color;
    return (
      <View key={node.key} style={row}>
        <View style={[layout.bulletMarker, direction ? layout.dotAfter : layout.dotBefore]}>
          <Text style={marker} accessible={false} importantForAccessibility="no">
            {ZERO_WIDTH_SPACE}
          </Text>
          <View style={[layout.bulletDot, { backgroundColor: dotColor ?? body?.color }]} />
        </View>
        <View style={layout.listContent}>{children}</View>
      </View>
    );
  }
  if (list?.type === "ordered_list") {
    const start = Number(list.attributes?.start);
    const number = Number.isFinite(start) ? start + node.index : node.index + 1;
    return (
      <View key={node.key} style={row}>
        <NumberColumn list={list} markup={node.markup} reversed={Boolean(direction)}>
          <Text style={[marker, styleMap.ordered_list_icon]}>
            {number}
            {node.markup}
          </Text>
        </NumberColumn>
        <View style={layout.listContent}>{children}</View>
      </View>
    );
  }
  return (
    <View key={node.key} style={styleMap._VIEW_SAFE_list_item}>
      {children}
    </View>
  );
}
