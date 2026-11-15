import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";

/** True for a fence whose info string names Mermaid (```mermaid, ```Mermaid title="x"). */
export function isMermaidFence(info: string | undefined | null): boolean {
  return (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() === "mermaid";
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * Mermaid's SVG as an image source. Mermaid sizes the SVG to its container (`width="100%"`), which
 * gives an image no size of its own, so the viewBox becomes its width and height. The alt text is
 * the diagram's `accTitle` when it has one.
 */
export function mermaidSvgImage(
  svg: string,
): { src: string; width: number; height: number; alt: string } | undefined {
  const open = /<svg\b[^>]*>/.exec(svg)?.[0];
  const viewBox =
    open &&
    /\sviewBox="([^"]+)"/
      .exec(open)?.[1]
      ?.trim()
      .split(/[\s,]+/);
  const width = Number(viewBox?.[2]);
  const height = Number(viewBox?.[3]);
  if (!open || !(width > 0) || !(height > 0)) return undefined;
  const sized = open
    .replace(/\s(width|height)="[^"]*"/g, "")
    .replace(/max-width:\s*[^;"]+;?\s*/, "")
    .replace(/^<svg\b/, `<svg width="${width}" height="${height}"`);
  const title = /<title\b[^>]*>([^<]*)<\/title>/.exec(svg)?.[1]?.trim();
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(open, () => sized))}`,
    width: Math.ceil(width),
    height: Math.ceil(height),
    alt: title
      ? title.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => XML_ENTITIES[e] ?? e)
      : "Diagram",
  };
}

/** The subset of Mermaid's config that chat diagrams set. Plain data, so a WebView can take it too. */
export type ChatMermaidConfig = {
  startOnLoad: false;
  securityLevel: "strict";
  secure: string[];
  suppressErrorRendering: true;
  htmlLabels: false;
  flowchart: { htmlLabels: false };
  theme: "base";
  darkMode: boolean;
  fontFamily: string;
  themeVariables: Record<string, string | boolean>;
};

// A system font: the diagram is drawn as an image, which cannot use the page's web font, and
// Mermaid sizes each box for the font it measured with.
export const CHAT_DIAGRAM_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Mermaid's default theme is drawn for a white page. The chat draws diagrams on the same card
 * a code block uses, so every colour comes from the app palette instead.
 *
 * `securityLevel: "strict"` keeps Mermaid's sanitizer on and turns off click handlers, and
 * labels are SVG text rather than HTML. `secure` lists the keys a diagram's own `%%{init}%%`
 * directive cannot change: Mermaid's defaults plus `htmlLabels` and the raw CSS options, which
 * Mermaid applies while measuring the diagram in the live page.
 *
 * `surface` is the colour the diagram is drawn on, which edge labels are filled with.
 */
export function chatMermaidConfig(
  palette: ColorTokens,
  appearance: ResolvedAppearance,
  { fontFamily = CHAT_DIAGRAM_FONT, surface = palette.card } = {},
): ChatMermaidConfig {
  const line = palette.mutedForeground;
  return {
    startOnLoad: false,
    securityLevel: "strict",
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "htmlLabels",
      "themeCSS",
      "fontFamily",
      "altFontFamily",
    ],
    suppressErrorRendering: true,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: "base",
    darkMode: appearance === "dark",
    fontFamily,
    themeVariables: {
      darkMode: appearance === "dark",
      fontFamily,
      fontSize: "14px",
      background: surface,
      textColor: palette.foreground,
      lineColor: line,
      primaryColor: palette.accent,
      primaryTextColor: palette.foreground,
      primaryBorderColor: line,
      secondaryColor: palette.secondary,
      secondaryTextColor: palette.foreground,
      secondaryBorderColor: line,
      tertiaryColor: palette.secondary,
      tertiaryTextColor: palette.foreground,
      tertiaryBorderColor: line,
      mainBkg: palette.accent,
      nodeBorder: line,
      nodeTextColor: palette.foreground,
      clusterBkg: palette.muted,
      clusterBorder: line,
      titleColor: palette.foreground,
      edgeLabelBackground: surface,
      noteBkgColor: palette.secondary,
      noteTextColor: palette.foreground,
      noteBorderColor: line,
      actorBkg: palette.accent,
      actorBorder: line,
      actorTextColor: palette.foreground,
      actorLineColor: line,
      signalColor: palette.foreground,
      signalTextColor: palette.foreground,
      labelBoxBkgColor: palette.accent,
      labelBoxBorderColor: line,
      labelTextColor: palette.foreground,
      loopTextColor: palette.foreground,
      activationBkgColor: palette.secondary,
      activationBorderColor: line,
      sequenceNumberColor: surface,
      errorBkgColor: palette.destructiveFill,
      errorTextColor: palette.destructiveForeground,
    },
  };
}
