import type { ColorTokens } from "@rakazo/ui-tokens";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { Platform, StyleSheet } from "react-native";

const BLOCK_GAP = 8;
const BODY_FONT_SIZE = typeScale.body.fontSize;
// "ui-monospace" is iOS's own monospaced system font, SF Mono.
const MONO_FONT = Platform.select({ ios: "ui-monospace", default: "monospace" });
const BULLET_SIZE = 5;
// List markers sit in an 18 pt column, 8 pt before the item text.
export const MARKER_COLUMN = 18;
const TASK_BOX_SIZE = 14;
const MARKER_GAP = 8;
const LINK_TILE_SIZE = 18;
const minorHeading = {
  ...typeScale.secondary,
  fontWeight: fontWeight.semibold,
  marginTop: 0,
  marginBottom: 0,
} as const;

const codeText = {
  fontFamily: MONO_FONT,
  fontSize: typeScale.caption.fontSize,
  lineHeight: undefined,
};

// The library pads code blocks by 10 already.
const codeBox = {
  borderWidth: 0,
  borderRadius: 10,
};

export function markdownStyles(palette: ColorTokens) {
  return StyleSheet.create({
    body: {
      color: palette.foreground,
      ...typeScale.body,
      width: "100%",
      minWidth: 0,
      flexShrink: 1,
      gap: BLOCK_GAP,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 0,
      width: "100%",
      flexShrink: 1,
    },
    heading1: {
      color: palette.foreground,
      ...typeScale.title,
      marginTop: 0,
      marginBottom: 0,
    },
    heading2: {
      color: palette.foreground,
      ...typeScale.headline,
      marginTop: 0,
      marginBottom: 0,
    },
    heading3: {
      color: palette.foreground,
      ...typeScale.body,
      fontWeight: fontWeight.semibold,
      marginTop: 0,
      marginBottom: 0,
    },
    heading4: minorHeading,
    heading5: minorHeading,
    heading6: minorHeading,
    strong: {
      color: palette.foreground,
      fontWeight: fontWeight.semibold,
    },
    link: {
      color: palette.link,
      textDecorationLine: "underline",
      marginBottom: 0,
    },
    // Inline code is set in the monospaced font alone, without a chip around it.
    code_inline: {
      color: palette.foreground,
      fontFamily: MONO_FONT,
      fontSize: typeScale.caption.fontSize,
      backgroundColor: "transparent",
      borderWidth: 0,
      padding: 0,
      borderRadius: 0,
    },
    // Code blocks keep the monospaced font's own line spacing.
    code_block: {
      color: palette.foreground,
      backgroundColor: palette.secondary,
      borderColor: palette.border,
      ...codeText,
      ...codeBox,
    },
    // The header and code sit inside the fence; a fill of their own would stack the translucent one.
    fence: {
      backgroundColor: palette.secondary,
      borderColor: palette.border,
      ...codeBox,
    },
    fence_code: {
      backgroundColor: "transparent",
    },
    fence_header: {
      backgroundColor: "transparent",
      borderBottomColor: palette.border,
    },
    fence_token: codeText,
    // Prose in a fence reads in the body font, not the monospaced one.
    fence_prose: {
      color: palette.foreground,
      ...typeScale.body,
    },
    fence_language_label: {
      color: palette.foreground,
      fontFamily: MONO_FONT,
    },
    blockquote: {
      backgroundColor: "transparent",
      color: palette.mutedForeground,
      borderLeftColor: palette.faintForeground,
      borderLeftWidth: 3,
      gap: BLOCK_GAP,
    },
    bullet_list_icon: {
      color: palette.faintForeground,
    },
    table: {
      borderColor: palette.input,
      borderWidth: StyleSheet.hairlineWidth,
    },
    tr: {
      borderColor: palette.input,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    th: {
      ...typeScale.caption,
      color: palette.foreground,
      fontWeight: fontWeight.medium,
    },
    td: {
      ...typeScale.caption,
      color: palette.mutedForeground,
    },
    bullet_list: {
      gap: BLOCK_GAP,
    },
    ordered_list: {
      gap: BLOCK_GAP,
    },
    ordered_list_icon: {
      color: palette.faintForeground,
      fontSize: typeScale.secondary.fontSize,
      fontVariant: ["tabular-nums"],
      marginLeft: 0,
      marginRight: 0,
    },
    hr: {
      backgroundColor: palette.border,
      height: StyleSheet.hairlineWidth,
    },
    // Custom keys. An image label outside a text node inherits no color, so it carries the body color.
    plain_text: {
      color: palette.foreground,
    },
    // The tap-to-load placeholder for a remote image: a filled, bordered chip that reads as a
    // control on the muted bot bubble in both themes.
    image_placeholder: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      minHeight: 32,
      maxWidth: "100%",
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.background,
    },
    image_placeholder_icon: {
      width: 14,
      height: 11,
      borderWidth: 1.5,
      borderRadius: 2,
      borderColor: palette.mutedForeground,
    },
    image_placeholder_alt: {
      flexShrink: 1,
      color: palette.foreground,
      fontSize: 14,
    },
    image_placeholder_host: {
      flexShrink: 1,
      color: palette.mutedForeground,
      fontSize: 13,
    },
    // A website link reads in the body colour. The icon tile is not underlined; only the label is.
    website_link: {
      color: palette.foreground,
      fontWeight: "500",
      textDecorationLine: "none",
    },
    website_link_label: {
      color: palette.foreground,
      fontWeight: "500",
      textDecorationLine: "underline",
      textDecorationColor: palette.input,
    },
    // A page named in a message keeps the text's colour; only a faint underline marks it.
    page_chip_title: {
      textDecorationLine: "underline",
      textDecorationColor:
        palette.foreground.length === 7 ? `${palette.foreground}4D` : palette.input,
    },
    link_favicon_plate: {
      backgroundColor: palette.faviconPlate,
      padding: 2,
    },
    linked_image: {
      width: "100%",
      maxWidth: "100%",
      alignItems: "flex-start",
      gap: 4,
    },
  });
}

export const layout = StyleSheet.create({
  wrap: {
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
  },
  // The marker ends where the item's text begins, on whichever side the row puts the text.
  numberBefore: {
    alignItems: "flex-end",
    marginRight: MARKER_GAP,
  },
  numberAfter: {
    alignItems: "flex-start",
    marginLeft: MARKER_GAP,
  },
  dotBefore: {
    marginLeft: MARKER_COLUMN - BULLET_SIZE,
    marginRight: MARKER_GAP,
  },
  dotAfter: {
    marginLeft: MARKER_GAP,
    marginRight: MARKER_COLUMN - BULLET_SIZE,
  },
  // Only as tall as the first line, so the dot stays on it when the item wraps. The dot sits
  // beside the invisible character and is centred on its line.
  bulletMarker: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
  },
  bulletDot: {
    width: BULLET_SIZE,
    height: BULLET_SIZE,
    borderRadius: BULLET_SIZE / 2,
  },
  taskBefore: {
    marginLeft: MARKER_COLUMN - TASK_BOX_SIZE,
    marginRight: MARKER_GAP,
  },
  taskAfter: {
    marginLeft: MARKER_GAP,
    marginRight: MARKER_COLUMN - TASK_BOX_SIZE,
  },
  taskBox: {
    width: TASK_BOX_SIZE,
    height: TASK_BOX_SIZE,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  taskCheck: { fontSize: 11, lineHeight: 13, fontWeight: "700" },
  // Deliberately no `flex: 1`: an automatic basis gives the item its text's natural width.
  listContent: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  reversedRow: {
    flexDirection: "row-reverse",
  },
  codeLine: {
    flexDirection: "row",
  },
  codeRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  // A prose fence wraps, so its text takes the width the copy control leaves it.
  proseCode: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  codeFrame: {
    overflow: "hidden",
  },
  // React Native mirrors `right` in a right-to-left app, so it is always the far side.
  farSideText: {
    textAlign: "right",
  },
  // A text group sits in a row; filling it lets a short line reach the far side too.
  farSideBlock: {
    textAlign: "right",
    width: "100%",
  },
  // An inline view sits on the baseline; this drops it so it centres on the capitals. The gap
  // before the label is part of the view, since inline views do not keep their margins.
  linkMarker: {
    width: LINK_TILE_SIZE + 4,
    height: LINK_TILE_SIZE,
    transform: [{ translateY: (LINK_TILE_SIZE - BODY_FONT_SIZE * 0.7) / 2 }],
  },
  linkTile: {
    width: LINK_TILE_SIZE,
    height: LINK_TILE_SIZE,
    padding: 1,
    borderRadius: 5,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  linkIcon: {
    width: "100%",
    height: "100%",
  },
});
