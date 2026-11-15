import type { ColorTokens } from "@rakazo/ui-tokens";
import { typeScale } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { Fragment, memo } from "react";
import type { TextStyle } from "react-native";
import { Text, View } from "react-native";
import { linkFaviconOrigin, linkLabel, plainTextLinkParts } from "../markdown";
import { MarkdownPageChip } from "./chips";
import { contraryDirection } from "./direction";
import { ISOLATE, LinkFavicon, POP_ISOLATE, useNativeLinkConfirm, WORD_JOINER } from "./links";
import { layout } from "./styles";

type LinkifiedTextProps = {
  children: string;
  color: string;
  linkColor: string;
  palette: ColorTokens;
  /** Renders the runs between links, which are plain strings by default. */
  renderText?: (text: string) => ReactNode;
  onOpenPage?: (pageId: string) => void;
};

const BLOCK_LENGTH = 1000;

/**
 * Long text in pieces of about BLOCK_LENGTH characters, cut only at line breaks, so a pasted
 * page is laid out and drawn as many small paragraphs instead of one huge one. Joined with
 * "\n" the pieces are the text again; a cut never leaves a piece ending in a blank line.
 */
export function textBlocks(text: string): string[] {
  if (text.length <= BLOCK_LENGTH) return [text];
  const blocks: string[] = [];
  let lines: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    lines.push(line);
    length += line.length + 1;
    if (length >= BLOCK_LENGTH && line !== "") {
      blocks.push(lines.join("\n"));
      lines = [];
      length = 0;
    }
  }
  if (lines.length === 0) return blocks;
  const last = blocks.length - 1;
  if (last >= 0 && lines.every((line) => line === "")) {
    blocks[last] += "\n".repeat(lines.length);
  } else {
    blocks.push(lines.join("\n"));
  }
  return blocks;
}

export const LinkifiedText = memo(function LinkifiedText({
  children,
  color,
  linkColor,
  palette,
  renderText,
  onOpenPage,
}: LinkifiedTextProps) {
  const openLink = useNativeLinkConfirm();
  const labelStyle: TextStyle = {
    color,
    fontWeight: "500",
    textDecorationLine: "underline",
    // Links in a bubble are the bubble's text colour, so the underline is what marks them.
    textDecorationColor: linkColor,
  };
  const style = [{ color, ...typeScale.body }, contraryDirection(children) && layout.farSideText];
  const paragraph = (text: string, key?: number) => (
    <Text key={key} style={style}>
      {plainTextLinkParts(text).map((part, index) => {
        if (part.type === "text") {
          return renderText ? (
            <Fragment key={index}>{renderText(part.value)}</Fragment>
          ) : (
            part.value
          );
        }
        if (part.type === "page") {
          return (
            <MarkdownPageChip
              key={index}
              pageId={part.pageId}
              titleStyle={{ textDecorationLine: "underline", textDecorationColor: linkColor }}
              onOpenPage={onOpenPage}
            >
              {part.value}
            </MarkdownPageChip>
          );
        }
        const open = () => {
          openLink(part.href);
        };
        if (!linkFaviconOrigin(part.href)) {
          return (
            <Text
              accessibilityRole="link"
              key={index}
              style={{ color: linkColor, textDecorationLine: "underline" }}
              onPress={open}
            >
              {part.value}
            </Text>
          );
        }
        const label = linkLabel(part.value, part.href);
        return (
          <Text
            accessibilityRole="link"
            accessibilityLabel={label}
            key={index}
            style={{ color, fontWeight: "500" }}
            onPress={open}
          >
            <LinkFavicon
              href={part.href}
              plate={{ backgroundColor: palette.faviconPlate, padding: 2 }}
            />
            {WORD_JOINER}
            {ISOLATE}
            <Text style={labelStyle}>{label}</Text>
            {POP_ISOLATE}
          </Text>
        );
      })}
    </Text>
  );
  const blocks = textBlocks(children);
  if (blocks.length === 1) return paragraph(children);
  return <View>{blocks.map((block, index) => paragraph(block, index))}</View>;
});
