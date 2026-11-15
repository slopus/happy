import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { darkTokens } from "@rakazo/ui-tokens";
import type { MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import { Highlight, themes } from "prism-react-renderer";
import type { ComponentType, ReactNode } from "react";
import { createContext, useContext } from "react";
import type { TextStyle } from "react-native";
import { Text, View } from "react-native";
import { contraryDirection } from "./direction";
import { SidewaysScrollView } from "./sideways-scroll";
import { layout } from "./styles";

export type MermaidDiagramProps = {
  source: string;
  palette: ColorTokens;
  colorScheme: ResolvedAppearance;
  /** The code block, for the app to show while the diagram draws or when it cannot. */
  fallback: ReactNode;
};

/**
 * Draws a ```mermaid fence. Mermaid needs a browser engine, so the app supplies the drawing
 * (a WebView); without one, a fence stays a code block.
 */
export const MermaidDiagramContext = createContext<ComponentType<MermaidDiagramProps> | null>(null);

/**
 * The app's control for copying a code block, given the code exactly as written. Without one,
 * code blocks have no copy control.
 */
export const CodeCopyButtonContext = createContext<ComponentType<{ code: string }> | null>(null);

/** Code in a sideways scroll view, with its copy control beside it so the control stays put. */
export function CodeScrollView({ code, children }: { code: string; children?: ReactNode }) {
  const CopyButton = useContext(CodeCopyButtonContext);
  const scrollView = <SidewaysScrollView>{children}</SidewaysScrollView>;
  if (!CopyButton || !/\S/.test(code)) return scrollView;
  return (
    <View style={layout.codeRow}>
      {scrollView}
      <CopyButton code={code} />
    </View>
  );
}

export const DiagramSurfaceContext = createContext<{
  streaming: boolean;
  palette: ColorTokens;
  colorScheme: ResolvedAppearance;
}>({ streaming: false, palette: darkTokens, colorScheme: "dark" });

export function MermaidFence({ source, fallback }: { source: string; fallback: ReactNode }) {
  const Diagram = useContext(MermaidDiagramContext);
  const { streaming, palette, colorScheme } = useContext(DiagramSurfaceContext);
  // A streaming reply may still be writing the fence, so it reads as code until the reply ends.
  if (!Diagram || streaming || !source.trim()) return fallback;
  return (
    <Diagram source={source} palette={palette} colorScheme={colorScheme} fallback={fallback} />
  );
}

/**
 * The library's fenced code block, drawn here so its lines keep their shape and scroll sideways
 * in the same scroll view as tables.
 */
export function CodeFence({
  code,
  language,
  colorScheme,
  styleMap,
}: {
  code: string;
  language: string;
  colorScheme: ResolvedAppearance;
  styleMap: MarkdownStyleMap;
}) {
  const theme = colorScheme === "dark" ? themes.oneDark : themes.oneLight;
  return (
    <View style={styleMap._VIEW_SAFE_fence}>
      <FenceHeader language={language} styleMap={styleMap} />
      <CodeScrollView code={code}>
        <Highlight theme={theme} code={code} language={language || "text"}>
          {({ tokens, getTokenProps }) => (
            <View style={styleMap._VIEW_SAFE_fence_code}>
              {tokens.map((line, lineIndex) => {
                const visible = line.filter((token) => !token.empty);
                // One Text per line, its tokens as spans: a Text per token made a long block
                // thousands of separately measured paragraphs.
                return (
                  <View key={lineIndex} style={layout.codeLine}>
                    <Text style={[{ color: theme.plain.color }, styleMap.fence_token]}>
                      {visible.length === 0
                        ? " "
                        : visible.map((token, tokenIndex) => {
                            const tokenStyle = getTokenProps({ token }).style;
                            return (
                              <Text
                                key={tokenIndex}
                                style={[
                                  // Prism leaves plain text to inherit the line's colour, which
                                  // React Native text doesn't. A colour set on fence_token wins.
                                  { color: theme.plain.color },
                                  styleMap.fence_token,
                                  tokenStyle?.color != null ? { color: tokenStyle.color } : null,
                                  tokenStyle?.fontStyle != null
                                    ? { fontStyle: tokenStyle.fontStyle as TextStyle["fontStyle"] }
                                    : null,
                                  tokenStyle?.fontWeight != null
                                    ? {
                                        fontWeight:
                                          tokenStyle.fontWeight as TextStyle["fontWeight"],
                                      }
                                    : null,
                                ]}
                              >
                                {token.content}
                              </Text>
                            );
                          })}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </Highlight>
      </CodeScrollView>
    </View>
  );
}

/** A fence's language label, above its code. */
function FenceHeader({ language, styleMap }: { language: string; styleMap: MarkdownStyleMap }) {
  if (!language) return null;
  return (
    <View style={styleMap._VIEW_SAFE_fence_header}>
      <Text style={styleMap.fence_language_label}>{language}</Text>
    </View>
  );
}

/**
 * A fence marked as plain text. Its lines wrap in the body font instead of keeping their shape
 * and scrolling sideways.
 */
export function ProseFence({
  code,
  language,
  styleMap,
}: {
  code: string;
  language: string;
  styleMap: MarkdownStyleMap;
}) {
  const CopyButton = useContext(CodeCopyButtonContext);
  const prose = (
    <View style={[styleMap._VIEW_SAFE_fence_code, layout.proseCode]}>
      {code.split("\n").map((line, index) => (
        // An empty line keeps its height through a space, as a blank code line does. Each line
        // aligns by its own direction, as a paragraph does.
        <Text
          key={index}
          style={[styleMap.fence_prose, contraryDirection(line) && layout.farSideText]}
        >
          {line || " "}
        </Text>
      ))}
    </View>
  );
  return (
    <View style={styleMap._VIEW_SAFE_fence}>
      <FenceHeader language={language} styleMap={styleMap} />
      {CopyButton && /\S/.test(code) ? (
        <View style={layout.codeRow}>
          {prose}
          <CopyButton code={code} />
        </View>
      ) : (
        prose
      )}
    </View>
  );
}
