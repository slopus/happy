import type {
  ASTNode,
  MarkdownStyleMap,
  RenderRules,
} from "@ronradtke/react-native-markdown-display";
import { renderRules as libraryRenderRules } from "@ronradtke/react-native-markdown-display";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  inlineMarkdownImageSrc,
  isProseFence,
  linkLabel,
  markdownMentionId,
  markdownPageId,
  remoteMarkdownImage,
  sanitizeMarkdownUrl,
} from "../markdown";
import { isMermaidFence } from "../mermaid";
import { astText, cellPlainText, enclosingLink, soleRemoteImage } from "./ast";
import { MarkdownMention, MarkdownPageChip } from "./chips";
import { CodeFence, CodeScrollView, MermaidFence, ProseFence } from "./code";
import { contraryDirection } from "./direction";
import { FitImage, LinkedRemoteImage, RemoteMarkdownImage } from "./images";
import {
  ISOLATE,
  isWebsiteLink,
  LinkFavicon,
  NativeLink,
  POP_ISOLATE,
  textStyleForParents,
  WORD_JOINER,
} from "./links";
import { listItemRule } from "./lists";
import { layout } from "./styles";
import { TableCell, TableRow, TableScrollView } from "./table";

// Keep links as Text so they stay inside textgroup; Pressable (a View) is laid out
// outside the text flow and collapses the bubble height, overlapping later messages.
export const renderRules: RenderRules = {
  list_item: listItemRule,
  fence: (node, _children, _parents, styleMap, _onCopyCode, colorScheme) => {
    const info = typeof node.sourceInfo === "string" ? node.sourceInfo : "";
    const source = node.content.replace(/\n$/, "");
    const language = info.trim().split(/\s+/)[0] ?? "";
    const codeBlock = isProseFence(language) ? (
      <ProseFence key={node.key} code={source} language={language} styleMap={styleMap} />
    ) : (
      <CodeFence
        key={node.key}
        code={source}
        language={language}
        colorScheme={colorScheme === "dark" ? "dark" : "light"}
        styleMap={styleMap}
      />
    );
    if (!isMermaidFence(info)) return codeBlock;
    return <MermaidFence key={node.key} source={source} fallback={codeBlock} />;
  },
  // The frame moves from the text to a view around it, so the copy control sits inside it.
  code_block: (node, children, parents, styleMap, ...extra) => {
    const { borderWidth, borderColor, borderRadius, backgroundColor, ...text } =
      StyleSheet.flatten(styleMap.code_block) ?? {};
    return (
      <View
        key={node.key}
        style={[{ borderWidth, borderColor, borderRadius, backgroundColor }, layout.codeFrame]}
      >
        <CodeScrollView code={node.content.replace(/\n$/, "")}>
          {/* The library's own rule, made here so it draws with the app's Text, which the app
              replaces after this file loads. */}
          {libraryRenderRules(Text).code_block?.(
            node,
            children,
            parents,
            { ...styleMap, code_block: text },
            ...extra,
          )}
        </CodeScrollView>
      </View>
    );
  },
  textgroup: (node, children, _parent, styleMap) => (
    <Text
      key={node.key}
      style={[styleMap.textgroup, contraryDirection(cellPlainText(node)) && layout.farSideBlock]}
    >
      {children}
    </Text>
  ),
  text: (node, _children, parents, styleMap, inherited) => (
    <Text key={node.key} style={textStyleForParents(inherited, parents, styleMap)}>
      {node.content}
    </Text>
  ),
  table: (node, children, _parent, styleMap) => (
    <TableScrollView key={node.key} table={node} style={styleMap._VIEW_SAFE_table}>
      {children}
    </TableScrollView>
  ),
  tr: (node, children, _parent, styleMap) => (
    <TableRow key={node.key} baseStyle={styleMap._VIEW_SAFE_tr}>
      {children}
    </TableRow>
  ),
  th: (node, children, _parent, styleMap) => (
    <TableCell key={node.key} columnIndex={node.index} baseStyle={styleMap._VIEW_SAFE_th}>
      {children}
    </TableCell>
  ),
  td: (node, children, _parent, styleMap) => (
    <TableCell key={node.key} columnIndex={node.index} baseStyle={styleMap._VIEW_SAFE_td}>
      {children}
    </TableCell>
  ),
  link: (node, children, _parent, styleMap) => renderMarkdownLink(node, children, styleMap, false),
  blocklink: (node, children, _parent, styleMap) =>
    renderMarkdownLink(node, children, styleMap, true),
  // Replaces the library rule, which loads any http(s) image and prefixes https:// to the rest.
  image: (node, _children, parents, styleMap) => {
    const src = node.attributes.src ?? "";
    const alt = node.attributes.alt;
    if (inlineMarkdownImageSrc(src)) {
      return (
        <FitImage
          key={node.key}
          // Embedded data has nothing to load; the spinner would stay over the image.
          indicator={false}
          style={styleMap._VIEW_SAFE_image}
          source={{ uri: src }}
          accessible={Boolean(alt)}
          accessibilityLabel={alt}
        />
      );
    }
    const linkParent = enclosingLink(parents);
    const linkOpens = Boolean(linkParent && sanitizeMarkdownUrl(linkParent.attributes.href ?? ""));
    const labelStyle = linkOpens ? styleMap.link : styleMap.plain_text;
    const remote = remoteMarkdownImage(src);
    if (remote) {
      return (
        <RemoteMarkdownImage
          key={node.key}
          image={remote}
          alt={alt}
          title={node.attributes.title}
          insideLink={Boolean(linkParent)}
          rejectedLink={Boolean(linkParent) && !linkOpens}
          labelStyle={labelStyle}
          styleMap={styleMap}
        />
      );
    }
    return (
      <Text key={node.key} style={labelStyle}>
        {alt || src}
      </Text>
    );
  },
};

function renderMarkdownLink(
  node: ASTNode,
  children: ReactNode[],
  styleMap: MarkdownStyleMap,
  block: boolean,
) {
  const pageId = markdownPageId(node.attributes.href);
  if (pageId) {
    return (
      <MarkdownPageChip key={node.key} pageId={pageId} titleStyle={styleMap.page_chip_title}>
        {children}
      </MarkdownPageChip>
    );
  }
  const mentionId = markdownMentionId(node.attributes.href);
  if (mentionId) {
    return (
      <MarkdownMention key={node.key} id={mentionId} name={astText(node) ?? ""}>
        {children}
      </MarkdownMention>
    );
  }
  const href = sanitizeMarkdownUrl(node.attributes.href ?? "");
  if (!href) return <Text key={node.key}>{children}</Text>;
  const image = soleRemoteImage(node);
  if (image) {
    return (
      <LinkedRemoteImage
        key={node.key}
        href={href}
        image={image.remote}
        alt={image.alt}
        title={image.title}
        styleMap={styleMap}
      />
    );
  }
  if (!block && isWebsiteLink(node)) {
    const text = astText(node);
    return (
      <NativeLink
        href={href}
        accessibilityLabel={text === undefined ? undefined : linkLabel(text, href)}
        key={node.key}
        style={styleMap.website_link}
      >
        <LinkFavicon href={href} plate={styleMap.link_favicon_plate} />
        {WORD_JOINER}
        {ISOLATE}
        {text === undefined ? (
          children
        ) : (
          <Text style={styleMap.website_link_label}>{linkLabel(text, href)}</Text>
        )}
        {POP_ISOLATE}
      </NativeLink>
    );
  }
  if (!block) {
    return (
      <NativeLink href={href} key={node.key} style={styleMap.link}>
        {children}
      </NativeLink>
    );
  }
  return (
    <NativeLink block href={href} key={node.key} style={styleMap.blocklink}>
      <View style={styleMap.image}>{children}</View>
    </NativeLink>
  );
}
