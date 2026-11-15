import type { ASTNode, MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import { Alert, Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import {
  LinkFaviconsContext,
  linkFaviconOrigin,
  markdownLinkNeedsPrompt,
  markdownLinkSite,
  sanitizeMarkdownUrl,
  useLinkFavicon,
} from "../markdown";
import {
  useMarkdownLinkAppOrigin,
  useMarkdownLinkCopy,
  useMarkdownLinkTrust,
} from "../markdown-link-prompt";
import { astHasImage, enclosingLink } from "./ast";
import { layout } from "./styles";

// Keeps the site icon on the line of the label's first word.
export const WORD_JOINER = "\u2060";
// First-strong isolate and its pop: a label's own direction characters cannot reorder the text
// around the link.
export const ISOLATE = "\u2068";
export const POP_ISOLATE = "\u2069";

async function openSafeLink(url: string) {
  const safeUrl = sanitizeMarkdownUrl(url);
  if (!safeUrl) return;
  if (await Linking.canOpenURL(safeUrl)) await Linking.openURL(safeUrl);
}

export const OpenLinkContext = createContext<(url: string) => void>(() => undefined);

/** Opens a link the way a chat link opens: through the prompt unless it is in-app or trusted. */
export function useNativeLinkConfirm() {
  const appOrigin = useMarkdownLinkAppOrigin();
  const copy = useMarkdownLinkCopy();
  const { sites, trust } = useMarkdownLinkTrust();
  return useCallback(
    (raw: string) => {
      const url = sanitizeMarkdownUrl(raw);
      if (!url) return;
      if (!markdownLinkNeedsPrompt(url, appOrigin, sites)) {
        void openSafeLink(url);
        return;
      }
      const site = trust ? markdownLinkSite(url) : undefined;
      // Keep the actual host visible even when userinfo or the path is very long.
      Alert.alert(
        copy.title,
        `${new URL(url).host}\n\n${url}`,
        [
          { text: copy.cancel, style: "cancel" },
          ...(trust && site
            ? [
                {
                  text: copy.alwaysOpen(site),
                  onPress: () => {
                    void openSafeLink(url);
                    trust(url);
                  },
                },
              ]
            : []),
          {
            text: copy.open,
            onPress: () => {
              void openSafeLink(url);
            },
          },
        ],
        { cancelable: true },
      );
    },
    [appOrigin, copy, sites, trust],
  );
}

export function NativeLink({
  block = false,
  href,
  ...props
}: {
  block?: boolean;
  href: string;
  children?: ReactNode;
  style?: StyleProp<TextStyle> | StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const open = useContext(OpenLinkContext);
  const onPress = (event: { defaultPrevented?: boolean }) => {
    if (!event.defaultPrevented) open(href);
  };
  return block ? (
    <Pressable
      {...props}
      style={props.style as StyleProp<ViewStyle>}
      accessibilityRole="link"
      onPress={onPress}
    />
  ) : (
    <Text
      {...props}
      style={props.style as StyleProp<TextStyle>}
      accessibilityRole="link"
      onPress={onPress}
    />
  );
}

export function linkHost(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
}

/** An inline link to a website, drawn with its site icon. Other links keep the plain link style. */
export function isWebsiteLink(node: ASTNode): boolean {
  const href = sanitizeMarkdownUrl(node.attributes.href ?? "");
  return node.type === "link" && Boolean(href && linkFaviconOrigin(href)) && !astHasImage(node);
}

export function LinkFavicon({ href, plate }: { href: string; plate: StyleProp<ViewStyle> }) {
  const { icon, unusable } = useLinkFavicon(href);
  const globe = useContext(LinkFaviconsContext)?.globe;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={layout.linkMarker}
    >
      <View style={[layout.linkTile, icon ? plate : undefined]}>
        {icon ? (
          <Image
            source={{ uri: icon }}
            style={layout.linkIcon}
            resizeMode="contain"
            onLoad={(event) => {
              // A 1×1 image is a tracking pixel, not an icon.
              const { width, height } = event.nativeEvent.source;
              if (width <= 1 || height <= 1) unusable();
            }}
            onError={unusable}
          />
        ) : (
          globe
        )}
      </View>
    </View>
  );
}

export function textStyleForParents(
  inherited: unknown,
  parents: readonly ASTNode[],
  styleMap: MarkdownStyleMap,
) {
  if (!inherited || typeof inherited !== "object" || Array.isArray(inherited)) return undefined;
  const style = { ...(inherited as Record<string, unknown>) };
  const linkParent = enclosingLink(parents);
  if (linkParent && isWebsiteLink(linkParent)) {
    // The label style sets medium weight, but bold inside a label stays bold.
    const label = StyleSheet.flatten(styleMap.website_link_label) ?? {};
    return { ...style, ...label, fontWeight: style.fontWeight ?? label.fontWeight };
  }
  if (!linkParent || sanitizeMarkdownUrl(linkParent.attributes.href ?? "")) return style;
  const linkStyle = StyleSheet.flatten(styleMap.link) ?? {};
  const bodyStyle = StyleSheet.flatten(styleMap.body) ?? {};
  if (style.textDecorationLine === linkStyle.textDecorationLine) delete style.textDecorationLine;
  if (style.color === linkStyle.color) style.color = bodyStyle.color;
  return style;
}
