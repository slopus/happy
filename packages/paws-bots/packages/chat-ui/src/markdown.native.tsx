import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { darkTokens } from "@rakazo/ui-tokens";
import type { ASTNode, RenderRules } from "@ronradtke/react-native-markdown-display";
import Markdown, {
  createMarkdownIt,
  renderRules as libraryRenderRules,
  MarkdownStream,
} from "@ronradtke/react-native-markdown-display";
import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import type { ChatMarkdownProps } from "./markdown";
import { LinkFaviconsPausedContext, linkifyExplicitUrls } from "./markdown";
import { InlineChipsContext } from "./native/chips";
import { DiagramSurfaceContext } from "./native/code";
import { OpenLinkContext, useNativeLinkConfirm } from "./native/links";
import { markTaskListItems } from "./native/lists";
import { renderRules } from "./native/render-rules";
import { layout, markdownStyles } from "./native/styles";

function keepMarkdownLinkToken(_url: string) {
  return true;
}

// One shared parser: the Markdown components memoize on its identity.
const markdownParser = createMarkdownIt();
markdownParser.validateLink = keepMarkdownLinkToken;
linkifyExplicitUrls(markdownParser);
markTaskListItems(markdownParser);

/** A node's place in the tree, which stays the same when the same Markdown is parsed again. */
function markdownNodeKey(node: ASTNode, parents: readonly ASTNode[]): string {
  let path = `${node.index}`;
  for (const parent of parents) path = `${parent.index}.${path}`;
  return `${path}_${node.type}`;
}

/**
 * The library keys every node afresh on each parse, so each re-render (every streamed chunk)
 * remounted and re-measured the whole message. Keying nodes by place keeps unchanged blocks.
 */
function withPlaceKeys(rules: RenderRules): RenderRules {
  return Object.fromEntries(
    Object.entries(rules).map(([type, rule]) => [
      type,
      rule &&
        ((node, children, parents, ...extra) => {
          node.key = markdownNodeKey(node, parents);
          return rule(node, children, parents, ...extra);
        }),
    ]),
  );
}

let chatRenderRules: { text: typeof Text; rules: RenderRules } | undefined;

// Built from the current Text, which the app replaces after this file loads.
function placeKeyedRenderRules(): RenderRules {
  if (chatRenderRules?.text !== Text) {
    chatRenderRules = {
      text: Text,
      rules: withPlaceKeys({ ...libraryRenderRules(Text), ...renderRules }),
    };
  }
  return chatRenderRules.rules;
}

/** The code of each fenced or indented block in a message, as its copy button copies it. */
export function markdownCodeBlocks(markdown: string): string[] {
  const tokens: { type: string; content: string }[] = markdownParser.parse(markdown, {});
  return tokens
    .filter((token) => token.type === "fence" || token.type === "code_block")
    .map((token) => token.content.replace(/\n$/, ""))
    .filter((code) => /\S/.test(code));
}

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  renderMention,
  onOpenPage,
  palette = darkTokens,
  colorScheme = "dark",
}: ChatMarkdownProps & { palette?: ColorTokens; colorScheme?: ResolvedAppearance }) {
  const openLink = useNativeLinkConfirm();
  const styles = useMemo(() => markdownStyles(palette), [palette]);
  const diagramSurface = useMemo(
    () => ({ streaming, palette, colorScheme }),
    [streaming, palette, colorScheme],
  );
  const sharedProps = {
    colorScheme,
    markdownit: markdownParser,
    style: styles,
    rules: placeKeyedRenderRules(),
    onLinkPress: (url: string) => {
      openLink(url);
      return false;
    },
  };

  const inlineChips = useMemo(
    () => ({ renderMention, onOpenPage, palette }),
    [renderMention, onOpenPage, palette],
  );
  return (
    <OpenLinkContext.Provider value={openLink}>
      <InlineChipsContext.Provider value={inlineChips}>
        <View style={layout.wrap}>
          <LinkFaviconsPausedContext.Provider value={streaming}>
            <DiagramSurfaceContext.Provider value={diagramSurface}>
              {streaming ? (
                <MarkdownStream {...sharedProps} cursorColor={palette.mutedForeground} streaming>
                  {children}
                </MarkdownStream>
              ) : (
                <Markdown {...sharedProps}>{children}</Markdown>
              )}
            </DiagramSurfaceContext.Provider>
          </LinkFaviconsPausedContext.Provider>
        </View>
      </InlineChipsContext.Provider>
    </OpenLinkContext.Provider>
  );
});

export type { ChatMarkdownProps, LinkFavicons } from "./markdown";
export {
  LinkFaviconsContext,
  plainTextLinkParts,
  RemoteImagesContext,
  useLinkFavicon,
  withBlockMentions,
} from "./markdown";
export { MarkdownLinkPromptProvider } from "./markdown-link-prompt";
export { PageIcon } from "./native/chips";
export type { MermaidDiagramProps } from "./native/code";
export { CodeCopyButtonContext, MermaidDiagramContext } from "./native/code";
export { RemoteMarkdownImage } from "./native/images";
export { LinkifiedText } from "./native/linkified-text";
export { useNativeLinkConfirm } from "./native/links";
export { MarkdownLongPressContext } from "./native/sideways-scroll";
