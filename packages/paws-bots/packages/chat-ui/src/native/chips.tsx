import type { ColorTokens } from "@rakazo/ui-tokens";
import { darkTokens, pageIconBars, typeScale } from "@rakazo/ui-tokens";
import type { MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Text, View } from "react-native";
import type { ChatMarkdownProps } from "../markdown";
import { PAGE_ICON } from "../page-icon";

/** What a chip in the text does: a mention's rendering, and opening a linked page. */
export const InlineChipsContext = createContext<
  Pick<ChatMarkdownProps, "renderMention" | "onOpenPage"> & { palette: ColorTokens }
>({ palette: darkTokens });

export function MarkdownMention({
  id,
  name,
  children,
}: {
  id: string;
  name: string;
  children: ReactNode;
}) {
  const { renderMention } = useContext(InlineChipsContext);
  return renderMention?.(id, name) ?? <Text>{children}</Text>;
}

/** `PAGE_ICON` drawn from views so it can sit inline in text; the flap is a border triangle. */
export function PageIcon({
  colors,
  width = PAGE_ICON.width,
  style,
}: {
  /** The app's resolved palette, which can differ from the device's color scheme. */
  colors: ColorTokens;
  width?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const s = width / PAGE_ICON.width;
  const { foldX, foldY, radius } = PAGE_ICON;
  const sheet = { position: "absolute", backgroundColor: colors.pageIconSheet } as const;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height: PAGE_ICON.height * s }, style]}
    >
      <View
        style={[
          sheet,
          {
            left: 0,
            top: 0,
            bottom: 0,
            width: foldX * s,
            borderTopLeftRadius: radius * s,
            borderBottomLeftRadius: radius * s,
          },
        ]}
      />
      <View
        style={[
          sheet,
          {
            left: foldX * s - 0.5,
            right: 0,
            top: foldY * s,
            bottom: 0,
            borderBottomRightRadius: radius * s,
          },
        ]}
      />
      <View
        style={{
          position: "absolute",
          left: foldX * s,
          top: 0,
          width: 0,
          height: 0,
          borderLeftWidth: (PAGE_ICON.width - foldX) * s,
          borderTopWidth: foldY * s,
          borderLeftColor: colors.pageIconFold,
          borderTopColor: "transparent",
        }}
      />
      {PAGE_ICON.lines.map((line) => (
        <View
          key={line.y}
          style={{
            position: "absolute",
            left: line.x * s,
            top: line.y * s,
            width: line.width * s,
            height: line.height * s,
            borderRadius: (line.height / 2) * s,
            backgroundColor: colors[line.token],
          }}
        />
      ))}
      {PAGE_ICON.bars.map((bar, index) => (
        <View
          key={bar.x}
          style={{
            position: "absolute",
            left: bar.x * s,
            top: bar.y * s,
            width: PAGE_ICON.barWidth * s,
            height: bar.height * s,
            borderRadius: (PAGE_ICON.barWidth / 2) * s,
            backgroundColor: pageIconBars[index],
          }}
        />
      ))}
    </View>
  );
}

// The chip's icon is 17/16 of the text, its bottom 2pt below the baseline and 7pt before the
// title at 16pt text. Inline views drop their margins, so the gap is part of the view.
const chipIconHeight = (typeScale.body.fontSize * 17) / 16;
const chipIconWidth = (chipIconHeight * PAGE_ICON.width) / PAGE_ICON.height;
const pageChipMarker = {
  width: chipIconWidth + (chipIconHeight * 7) / 17,
  height: chipIconHeight,
  transform: [{ translateY: (chipIconHeight * 2) / 17 }],
} as const;

export function MarkdownPageChip({
  pageId,
  children,
  titleStyle,
  onOpenPage,
}: {
  pageId: string;
  children: ReactNode;
  titleStyle: MarkdownStyleMap[string];
  /** A user bubble's opener; Markdown reads it from the message. */
  onOpenPage?: (pageId: string) => void;
}) {
  const { onOpenPage: fromMessage, palette } = useContext(InlineChipsContext);
  const openPage = onOpenPage ?? fromMessage;
  if (!openPage) return <Text>{children}</Text>;
  return (
    <Text accessibilityRole="link" onPress={() => openPage(pageId)}>
      <View style={pageChipMarker}>
        <PageIcon colors={palette} width={chipIconWidth} />
      </View>
      <Text style={titleStyle}>{children}</Text>
    </Text>
  );
}
