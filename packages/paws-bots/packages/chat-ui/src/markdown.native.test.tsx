// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const alert = vi.hoisted(() => vi.fn());

const linking = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => undefined),
}));

const i18n = vi.hoisted(() => ({ isRTL: false }));

// The iOS text size, as React Native reports it.
const windowSize = vi.hoisted(() => ({ fontScale: 1 }));

// The module's Text, which the app replaces with a capped one after this package has loaded.
const reactNativeText = vi.hoisted(() => ({ current: undefined as unknown }));

// The load handler of each rendered Image, so a test can report its decoded size.
const imageLoads = vi.hoisted(
  () =>
    [] as Array<(event: { nativeEvent: { source: { width: number; height: number } } }) => void>,
);

type TouchEvent = { nativeEvent: { pageX: number; pageY: number }; persist(): void };

const tableEvents = vi.hoisted(() => ({
  onLayout: undefined as
    | ((event: { nativeEvent: { layout: { width: number; height: number } } }) => void)
    | undefined,
  onStartShouldSetResponder: undefined as (() => boolean) | undefined,
  onResponderGrant: undefined as ((event: TouchEvent) => void) | undefined,
  onResponderMove: undefined as ((event: TouchEvent) => void) | undefined,
  onResponderRelease: undefined as (() => void) | undefined,
  onResponderTerminate: undefined as (() => void) | undefined,
  onContentSizeChange: undefined as ((width: number, height: number) => void) | undefined,
}));

// react-native ships uncompiled Flow source that node cannot load, so tests mock
// its component surface as marker elements that expose the layout props the
// render rules set (horizontal scrolling, per-row minimum width, cell width) and
// the color and hairline size of rules drawn inside a message.
vi.mock("react-native", async () => {
  const { createElement } = await import("react");

  const flattenStyle = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flattenStyle))
      : ((style ?? {}) as Record<string, unknown>);

  const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  const mockComponent = (tag: string, dataKeys: string[] = [], booleanKeys: string[] = []) =>
    function MockNativeComponent(props: Record<string, unknown>) {
      const {
        children,
        style,
        onPress,
        onLongPress,
        onAccessibilityAction: _onAccessibilityAction,
        ...rest
      } = props;
      const flattened = flattenStyle(style);
      const data: Record<string, unknown> = {};
      for (const key of dataKeys) {
        const value = rest[key] ?? flattened[key];
        if (value !== undefined && value !== null && value !== false) {
          data[`data-${kebab(key)}`] =
            value === true ? "true" : Array.isArray(value) ? value.join(" ") : value;
        }
      }
      for (const key of booleanKeys) {
        if (typeof rest[key] === "boolean") data[`data-${kebab(key)}`] = String(rest[key]);
      }
      if (tag === "rn-view" && typeof rest.onLayout === "function") {
        tableEvents.onLayout = rest.onLayout as typeof tableEvents.onLayout;
      }
      if (tag === "rn-view" && typeof rest.onStartShouldSetResponder === "function") {
        tableEvents.onStartShouldSetResponder =
          rest.onStartShouldSetResponder as typeof tableEvents.onStartShouldSetResponder;
        delete rest.onStartShouldSetResponder;
      }
      if (tag === "rn-view" && typeof rest.onResponderGrant === "function") {
        for (const key of [
          "onResponderGrant",
          "onResponderMove",
          "onResponderRelease",
          "onResponderTerminate",
        ] as const) {
          tableEvents[key] = rest[key] as never;
          delete rest[key];
        }
        delete rest.onResponderTerminationRequest;
      }
      if (tag === "rn-image" && typeof rest.onLoad === "function") {
        imageLoads.push(rest.onLoad as (typeof imageLoads)[number]);
        delete rest.onLoad;
        delete rest.onError;
      }
      if (tag === "rn-scroll-view" && typeof rest.onContentSizeChange === "function") {
        tableEvents.onContentSizeChange =
          rest.onContentSizeChange as typeof tableEvents.onContentSizeChange;
        delete rest.onContentSizeChange;
      }
      return createElement(
        tag,
        {
          ...rest,
          ...data,
          onContextMenu: onLongPress,
          onClick:
            typeof onPress === "function"
              ? (event: { preventDefault(): void; stopPropagation(): void }) => {
                  (onPress as (pressEvent: typeof event) => void)(event);
                }
              : undefined,
        },
        children as ReactNode,
      );
    };

  reactNativeText.current = mockComponent("rn-text", [
    "accessibilityRole",
    "accessibilityLabel",
    "textDecorationLine",
    "textDecorationColor",
    "color",
    "fontWeight",
    "fontFamily",
    "fontSize",
    "lineHeight",
    "fontVariant",
    "backgroundColor",
    "borderWidth",
    "textAlign",
    "writingDirection",
    "width",
    "maxFontSizeMultiplier",
  ]);

  return {
    View: mockComponent("rn-view", [
      "minWidth",
      "width",
      "maxWidth",
      "borderColor",
      "borderLeftColor",
      "backgroundColor",
      "borderWidth",
      "borderBottomWidth",
      "height",
      "gap",
      "marginTop",
      "marginBottom",
      "flexShrink",
      "flex",
      "flexGrow",
      "flexDirection",
      "overflow",
      "borderRadius",
      "borderLeftWidth",
      "alignItems",
      "alignSelf",
      "position",
      "top",
      "marginLeft",
      "marginRight",
      "accessibilityElementsHidden",
      "importantForAccessibility",
      "accessibilityRole",
    ]),
    get Text() {
      return reactNativeText.current;
    },
    ScrollView: mockComponent(
      "rn-scroll-view",
      ["horizontal", "borderColor", "borderWidth"],
      ["scrollEnabled", "showsHorizontalScrollIndicator", "showsVerticalScrollIndicator"],
    ),
    Pressable: mockComponent("rn-pressable", [
      "accessibilityRole",
      "borderBottomWidth",
      "backgroundColor",
    ]),
    TextInput: mockComponent("rn-text-input"),
    Image: mockComponent("rn-image"),
    Animated: {
      View: mockComponent("rn-animated-view"),
      createAnimatedComponent: (component: unknown) => component,
      timing: () => ({ start: () => undefined }),
      sequence: (...animations: unknown[]) => animations,
      loop: () => ({ start: () => undefined, stop: () => undefined }),
      delay: () => ({}),
      Value: class {},
    },
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: flattenStyle,
      hairlineWidth: 1,
      absoluteFillObject: {},
      absoluteFill: {},
    },
    Platform: {
      OS: "ios",
      select: (options: Record<string, unknown>) =>
        options.ios ?? options.default ?? options.android,
    },
    Linking: linking,
    Alert: { alert },
    I18nManager: i18n,
    useColorScheme: () => "dark",
    useWindowDimensions: () => windowSize,
  };
});

import { darkTokens, lightTokens, MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import { themes } from "prism-react-renderer";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { TextProps } from "react-native";
import { Platform, Pressable, StyleSheet } from "react-native";
import type { LinkFavicons, MermaidDiagramProps } from "./markdown.native";
import {
  ChatMarkdown,
  CodeCopyButtonContext,
  LinkFaviconsContext,
  LinkifiedText,
  MarkdownLinkPromptProvider,
  MarkdownLongPressContext,
  MermaidDiagramContext,
  markdownCodeBlocks,
  RemoteImagesContext,
  RemoteMarkdownImage,
} from "./markdown.native";
import { textBlocks } from "./native/linkified-text";

const THREE_COLUMN_TABLE = `| Name | Status | Detail |
| --- | --- | --- |
| Alice | done | [docs](https://docs.example.test) |
| Bob | queued | A longer note that wraps inside the cell |`;

const SIX_COLUMN_TABLE = `| A | B | C | D | E | F |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 | 3 | 4 | 5 | 6 |`;

const CONTENT_SIZED_TABLE = `| ID | City | Notes |
| --- | --- | --- |
| AL | Montgomery | This note is long enough to wrap inside the column instead of stretching the table without limit and turning the notes into a one letter strip. |`;

function numericWidths(html: string) {
  return [...html.matchAll(/data-width="(\d+(?:\.\d+)?)"/g)].map((match) => Number(match[1]));
}

// The data attributes of the innermost text element holding exactly `content`.
function textStyle(html: string, content: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const text = [...document.querySelectorAll("rn-text")]
    .reverse()
    .find((element) => element.textContent === content);
  if (!text) throw new Error(`no text "${content}"`);
  return Object.fromEntries(
    [...text.attributes]
      .filter((attribute) => attribute.name.startsWith("data-"))
      .map((a) => [a.name, a.value]),
  );
}

const BULLET_DOT = 'rn-view[data-width="5"][data-height="5"]';

function bulletDots(html: string) {
  return [...new DOMParser().parseFromString(html, "text/html").querySelectorAll(BULLET_DOT)];
}

// The view around a bullet dot, which also holds the line that centres it.
function isBulletDot(element: Element | null | undefined) {
  return [...(element?.children ?? [])].some((child) => child.matches(BULLET_DOT));
}

// The view around an ordered-list number.
function isNumberColumn(element: Element | null | undefined) {
  const number = element?.firstElementChild;
  return (
    element?.tagName.toLowerCase() === "rn-view" &&
    number?.tagName.toLowerCase() === "rn-text" &&
    /^\d+[.)]$/.test(number.textContent ?? "")
  );
}

function numberColumns(html: string) {
  return [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("rn-view")].filter(
    isNumberColumn,
  );
}

function tableRows(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  return [...document.querySelectorAll("rn-view[data-border-bottom-width]")].map((row) => ({
    width: Number(row.getAttribute("data-width")),
    cells: [...row.querySelectorAll("rn-view[data-max-width]")].map((cell) =>
      Number(cell.getAttribute("data-width")),
    ),
  }));
}

describe("native markdown tables", () => {
  it("wraps the table in a horizontal scroll view", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{THREE_COLUMN_TABLE}</ChatMarkdown>);
    expect(html).toContain("<rn-scroll-view");
    expect(html).toContain('data-horizontal="true"');
  });

  it("sizes each row from its columns so wide tables scroll instead of collapsing", () => {
    const narrow = tableRows(
      renderToStaticMarkup(<ChatMarkdown>{THREE_COLUMN_TABLE}</ChatMarkdown>),
    );
    const wide = tableRows(renderToStaticMarkup(<ChatMarkdown>{SIX_COLUMN_TABLE}</ChatMarkdown>));
    expect(narrow.length).toBeGreaterThan(0);
    expect(wide.length).toBeGreaterThan(0);
    for (const row of [...narrow, ...wide]) {
      expect(row.width).toBeGreaterThan(0);
      expect(row.width).toBe(row.cells.reduce((total, width) => total + width, 0));
    }
    const narrowWidth = narrow[0]?.width ?? 0;
    for (const row of wide) expect(row.width).toBeGreaterThan(narrowWidth);
  });

  it("renders cell text and keeps inline links tappable inside cells", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{THREE_COLUMN_TABLE}</ChatMarkdown>);
    expect(html).toContain("Alice");
    expect(html).toContain("A longer note that wraps inside the cell");
    expect(html).toContain('data-accessibility-role="link"');
    expect(html).toContain('data-text-decoration-line="underline"');
    expect(html).toContain("docs");
  });

  it("sizes columns to their content, keeps a column one width, and caps long text", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{CONTENT_SIZED_TABLE}</ChatMarkdown>);
    const rows = tableRows(html);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.cells).toHaveLength(3);
      expect(row.width).toBe(row.cells.reduce((total, width) => total + width, 0));
    }
    const [header, body] = rows;
    expect(header?.cells).toEqual(body?.cells);
    const [id, city, notes] = header?.cells ?? [];
    expect(id).toBeLessThan(city ?? 0);
    expect(city).toBeGreaterThan(96);
    expect(city).toBeLessThan(notes ?? 0);
    expect(notes).toBeLessThan(400);
    expect(html.match(/data-font-weight="500"/g)).toHaveLength(3);
    expect(html).toContain('data-flex-shrink="0"');
  });

  it("lets every cell set its row's height, even in columns scrolled out of view", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{CONTENT_SIZED_TABLE}</ChatMarkdown>);
    });
    await act(async () => {
      tableEvents.onLayout?.({ nativeEvent: { layout: { width: 70, height: 40 } } });
    });

    const cells = [
      ...new DOMParser()
        .parseFromString(container.innerHTML, "text/html")
        .querySelectorAll("rn-view[data-border-bottom-width] rn-view[data-max-width]"),
    ];
    expect(cells).toHaveLength(6);
    for (const cell of cells) {
      expect(cell.getAttribute("data-height")).toBeNull();
      expect(cell.getAttribute("data-overflow")).toBeNull();
    }

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  describe.each(["ios", "android"])("on %s", (os) => {
    it.each([
      [
        "wide table",
        SIX_COLUMN_TABLE.replace("| A |", "| [A](https://example.com/docs) |"),
        200,
        true,
      ],
      ["fitting table", THREE_COLUMN_TABLE, 1000, false],
      ["wide code", "```xml\nlong code line\n```", 200, true],
      ["fitting code", "```xml\nshort\n```", 1000, false],
    ])(
      "claims overflowing content at touch start on a %s",
      async (_case, markdown, width, overflows) => {
        vi.useFakeTimers();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        const platform = Platform as { OS: string };
        const previousOS = platform.OS;
        platform.OS = os;
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        const openMenu = vi.fn();
        const touch = (pageX: number, pageY: number) => ({
          nativeEvent: { pageX, pageY },
          persist() {},
        });
        try {
          await act(async () => {
            root.render(
              <Pressable onLongPress={os === "ios" ? undefined : openMenu}>
                <MarkdownLongPressContext.Provider value={os === "ios" ? undefined : openMenu}>
                  <ChatMarkdown>{markdown}</ChatMarkdown>
                </MarkdownLongPressContext.Provider>
              </Pressable>,
            );
          });
          await act(async () => {
            tableEvents.onLayout?.({ nativeEvent: { layout: { width, height: 40 } } });
            if (_case.includes("code")) tableEvents.onContentSizeChange?.(500, 40);
          });

          expect(tableEvents.onStartShouldSetResponder?.()).toBe(overflows);
          const timersBeforeTouch = vi.getTimerCount();
          if (overflows) expect(tableEvents.onResponderGrant?.(touch(100, 100))).toBeUndefined();
          // iOS leaves long presses to the native context menu without a JS timer.
          if (os === "ios") expect(vi.getTimerCount()).toBe(timersBeforeTouch);
          vi.advanceTimersByTime(499);
          expect(openMenu).not.toHaveBeenCalled();
          vi.advanceTimersByTime(1);
          vi.advanceTimersByTime(500);
          expect(openMenu).toHaveBeenCalledTimes(overflows && os !== "ios" ? 1 : 0);
          if (_case === "wide table") {
            alert.mockClear();
            linking.openURL.mockClear();
            const link = container.querySelector<HTMLElement>("[data-accessibility-role='link']");
            expect(link).not.toBeNull();
            await act(async () => {
              link?.click();
            });
            expect(alert).toHaveBeenCalledTimes(1);
            const buttons = alert.mock.calls[0]?.[2];
            await act(async () => {
              buttons[1].onPress();
            });
            expect(linking.openURL).toHaveBeenCalledWith("https://example.com/docs");
            expect(openMenu).toHaveBeenCalledTimes(overflows && os !== "ios" ? 1 : 0);
          }

          expect(
            container.querySelector("rn-scroll-view")?.getAttribute("data-scroll-enabled"),
          ).toBe(String(overflows));
        } finally {
          vi.useRealTimers();
          platform.OS = previousOS;
          await act(async () => {
            root.unmount();
          });
          container.remove();
        }
      },
    );
  });

  it.each(["move horizontally", "move vertically", "release", "terminate", "unmount"])(
    "cancels a claimed long press on %s",
    async (reason) => {
      vi.useFakeTimers();
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const root = createRoot(document.createElement("div"));
      const openMenu = vi.fn();
      try {
        await act(async () => {
          root.render(
            <MarkdownLongPressContext.Provider value={openMenu}>
              <ChatMarkdown>{SIX_COLUMN_TABLE}</ChatMarkdown>
            </MarkdownLongPressContext.Provider>,
          );
        });
        await act(async () => {
          tableEvents.onLayout?.({ nativeEvent: { layout: { width: 200, height: 40 } } });
        });
        tableEvents.onResponderGrant?.({ nativeEvent: { pageX: 100, pageY: 100 }, persist() {} });
        vi.advanceTimersByTime(499);
        if (reason.startsWith("move"))
          tableEvents.onResponderMove?.({
            nativeEvent: {
              pageX: reason === "move horizontally" ? 106 : 100,
              pageY: reason === "move vertically" ? 106 : 100,
            },
            persist() {},
          });
        if (reason === "release") tableEvents.onResponderRelease?.();
        if (reason === "terminate") tableEvents.onResponderTerminate?.();
        if (reason === "unmount") await act(async () => root.unmount());
        vi.advanceTimersByTime(500);
        expect(openMenu).not.toHaveBeenCalled();
      } finally {
        if (reason !== "unmount") await act(async () => root.unmount());
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["fits", THREE_COLUMN_TABLE, 1000, "false"],
    ["is wider than the bubble", SIX_COLUMN_TABLE, 200, "true"],
  ])("exposes scrolling only when the table %s", async (_case, table, width, scrolls) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{table}</ChatMarkdown>);
    });
    await act(async () => {
      tableEvents.onLayout?.({ nativeEvent: { layout: { width, height: 40 } } });
    });

    const scrollView = container.querySelector("rn-scroll-view");
    expect(scrollView?.getAttribute("data-scroll-enabled")).toBe(scrolls);
    expect(scrollView?.getAttribute("data-shows-horizontal-scroll-indicator")).toBe(scrolls);
    expect(scrollView?.getAttribute("data-shows-vertical-scroll-indicator")).toBe("false");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it.each([
    ["light", lightTokens],
    ["dark", darkTokens],
  ] as const)(
    "draws table, quote, list and divider colours on the %s bot bubble",
    (scheme, palette) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown palette={palette} colorScheme={scheme}>
          {`${THREE_COLUMN_TABLE}\n\n> A quote\n\n- An item\n\n---`}
        </ChatMarkdown>,
      );
      const hairline = "1";
      expect(html).toMatch(
        new RegExp(
          `<rn-scroll-view[^>]*data-border-color="${palette.input}"[^>]*data-border-width="${hairline}"`,
        ),
      );
      const rows = html.match(
        new RegExp(
          `<rn-view[^>]*data-border-color="${palette.input}"[^>]*data-border-bottom-width="${hairline}"`,
          "g",
        ),
      );
      expect(rows).toHaveLength(3);
      expect(html).toContain(`data-border-left-color="${palette.faintForeground}"`);
      expect(html).toMatch(
        new RegExp(
          `<rn-view[^>]*data-background-color="${palette.border}"[^>]*data-height="${hairline}"`,
        ),
      );
      const texts = [
        ...new DOMParser().parseFromString(html, "text/html").querySelectorAll("rn-text"),
      ];
      const colorOf = (label: string) =>
        texts.findLast((text) => text.textContent === label)?.getAttribute("data-color");
      expect(colorOf("Name")).toBe(palette.foreground);
      expect(colorOf("Alice")).toBe(palette.mutedForeground);
      expect(colorOf("A quote")).toBe(palette.mutedForeground);
      expect(bulletDots(html)[0]?.getAttribute("data-background-color")).toBe(
        palette.faintForeground,
      );
    },
  );

  it("applies the same table layout while streaming", () => {
    const html = renderToStaticMarkup(<ChatMarkdown streaming>{SIX_COLUMN_TABLE}</ChatMarkdown>);
    expect(html).toContain("<rn-scroll-view");
    expect(html).toContain('data-horizontal="true"');
    const widths = numericWidths(html);
    expect(widths[0]).toBeGreaterThan(0);
  });

  it("separates top-level blocks with one gap and no leading or trailing margin", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {[
          "## Rollout",
          "",
          "Intro paragraph.",
          "",
          "- One",
          "- Two",
          "",
          CONTENT_SIZED_TABLE,
          "",
          "> First quoted paragraph.",
          ">",
          "> Second quoted paragraph.",
          "",
          "---",
          "",
          "Trailing paragraph.",
        ].join("\n")}
      </ChatMarkdown>,
    );
    expect(html).toContain('data-gap="8"');
    expect(html).toMatch(/data-border-left-color="[^"]+"[^>]*data-gap="8"/);
    expect(html).not.toContain('data-margin-top="10"');
    expect(html).not.toContain('data-margin-bottom="9"');
    expect(html).not.toContain('data-margin-bottom="5"');
    expect(html).toContain('data-margin-top="0"');
    expect(html).toContain('data-margin-bottom="0"');
  });
});

describe("native markdown code blocks", () => {
  it.each(["first\n\nthird", "first\n\nthird\n", "first\n\nthird\n```"])(
    "preserves blank fence lines without adding a trailing row: %j",
    (code) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown colorScheme="light">{`\`\`\`\n${code}`}</ChatMarkdown>,
      );
      const document = new DOMParser().parseFromString(html, "text/html");
      const rows = document.querySelectorAll("rn-scroll-view rn-view[data-flex-direction='row']");
      expect(rows).toHaveLength(3);
      expect([...rows].map((row) => row.textContent)).toEqual(["first", " ", "third"]);
      const tokens = [...rows].map((row) => row.querySelector("rn-text"));
      for (const token of tokens) {
        expect(token).not.toBeNull();
        expect(token?.getAttribute("data-color")).toBe(themes.oneLight.plain.color);
        for (const attribute of ["data-font-family", "data-font-size"]) {
          expect(token?.getAttribute(attribute)).toBeTruthy();
          expect(token?.getAttribute(attribute)).toBe(tokens[0]?.getAttribute(attribute));
        }
        // Code keeps the monospaced font's own line spacing, so a blank line is as tall as the rest.
        expect(token?.getAttribute("data-line-height")).toBe(
          tokens[0]?.getAttribute("data-line-height"),
        );
      }
    },
  );

  const LONG_LINE =
    '<settings><entry key="preview.enabled" value="true" note="a line wider than the bubble"/></settings>';

  it.each([
    [
      "scrolls a fence with a line wider than the bubble",
      `\`\`\`xml\n${LONG_LINE}\n\`\`\``,
      900,
      true,
    ],
    ["keeps a fence that fits still", "```\nok\n```", 40, false],
    [
      "scrolls an indented code block with a line wider than the bubble",
      `    ${LONG_LINE}`,
      900,
      true,
    ],
    [
      "scrolls a mermaid fence the app draws as code",
      `\`\`\`mermaid\n${LONG_LINE}\n\`\`\``,
      900,
      true,
    ],
  ])("%s", async (_case, markdown, width, scrolls) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    tableEvents.onContentSizeChange = undefined;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    await act(async () => {
      tableEvents.onLayout?.({ nativeEvent: { layout: { width: 200, height: 40 } } });
      tableEvents.onContentSizeChange?.(width, 40);
    });

    const scrollViews = container.querySelectorAll("rn-scroll-view");
    expect(scrollViews).toHaveLength(1);
    const scrollView = scrollViews[0];
    expect(scrollView?.getAttribute("data-horizontal")).toBe("true");
    expect(scrollView?.getAttribute("data-scroll-enabled")).toBe(String(scrolls));
    expect(scrollView?.getAttribute("data-shows-horizontal-scroll-indicator")).toBe(
      String(scrolls),
    );
    expect(tableEvents.onStartShouldSetResponder?.()).toBe(scrolls);
    expect(scrollView?.textContent).toBe(markdown.includes(LONG_LINE) ? LONG_LINE : "ok");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("native markdown prose fences", () => {
  const draft =
    "Dear team, this line of prose is far wider than a bubble, so it wraps instead of scrolling.";

  // Stands in for the app's copy button, as the code copy tests do.
  function CopyProbe({ code }: { code: string }) {
    return createElement("copy-probe", { "data-code": code });
  }

  it.each(["text", "txt", "plaintext", "Text"])(
    "wraps a fence marked %j as prose in the body font",
    (language) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown palette={lightTokens} colorScheme="light">
          {`\`\`\`${language}\n${draft}\n\`\`\``}
        </ChatMarkdown>,
      );
      const document = new DOMParser().parseFromString(html, "text/html");
      // No sideways scroll view: the line wraps inside the fence's card.
      expect(document.querySelector("rn-scroll-view")).toBeNull();
      expect(
        document.querySelector(`[data-background-color="${lightTokens.secondary}"]`),
      ).not.toBeNull();
      expect(textStyle(html, draft)).toMatchObject({
        "data-color": lightTokens.foreground,
        "data-font-size": "17",
        "data-line-height": "22",
      });
      expect(textStyle(html, draft)["data-font-family"]).toBeUndefined();
    },
  );

  it.each(["ts", ""])(
    "keeps a fence marked %j monospaced in a sideways scroll view",
    (language) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown colorScheme="light">{`\`\`\`${language}\nconst a = 1;\n\`\`\``}</ChatMarkdown>,
      );
      const document = new DOMParser().parseFromString(html, "text/html");
      expect(document.querySelector("rn-scroll-view")).not.toBeNull();
      expect(
        document.querySelector("rn-scroll-view rn-text")?.getAttribute("data-font-family"),
      ).toBe("ui-monospace");
    },
  );

  it("preserves a prose fence's lines and blank lines", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown colorScheme="light">
        {"```text\nDear team,\n\n  see you Monday.\n```"}
      </ChatMarkdown>,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const lines = [...document.querySelectorAll("rn-text")]
      .filter((text) => !text.querySelector("rn-view"))
      .map((text) => text.textContent);
    expect(lines).toEqual(["text", "Dear team,", " ", "  see you Monday."]);
  });

  it("gives a prose fence a copy button for its exact code, outside any scroll view", () => {
    const code = "Dear team,\n\n  see you Monday.";
    const html = renderToStaticMarkup(
      <CodeCopyButtonContext.Provider value={CopyProbe}>
        <ChatMarkdown
          palette={lightTokens}
          colorScheme="light"
        >{`\`\`\`text\n${code}\n\`\`\``}</ChatMarkdown>
      </CodeCopyButtonContext.Provider>,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const probes = document.querySelectorAll("copy-probe");
    expect(probes).toHaveLength(1);
    expect(probes[0]?.getAttribute("data-code")).toBe(code);
    expect(probes[0]?.closest("rn-scroll-view")).toBeNull();
    // The button sits inside the fence's frame, beside the prose.
    const frame = probes[0]?.parentElement?.parentElement;
    expect(frame?.getAttribute("data-border-width")).toBeTruthy();
    expect(frame?.getAttribute("data-background-color")).toBe(lightTokens.secondary);
  });

  it("aligns each prose line by its own direction, like a paragraph", () => {
    const align = (markdown: string, line: string) =>
      textStyle(
        renderToStaticMarkup(<ChatMarkdown colorScheme="light">{markdown}</ChatMarkdown>),
        line,
      )["data-text-align"];
    expect(align("```text\nשלום רב.\nDear team,\n```", "שלום רב.")).toBe("right");
    expect(align("```text\nשלום רב.\nDear team,\n```", "Dear team,")).toBeUndefined();
    i18n.isRTL = true;
    try {
      // React Native mirrors `right` in a right-to-left layout, so it lands on the left.
      expect(align("```text\nDear team,\n```", "Dear team,")).toBe("right");
      expect(align("```text\nשלום רב.\n```", "שלום רב.")).toBeUndefined();
    } finally {
      i18n.isRTL = false;
    }
  });
});

describe("native markdown code copy", () => {
  // Stands in for the app's copy button, recording the code it would copy.
  function ProbeCopyButton({ code }: { code: string }) {
    return createElement("copy-probe", { "data-code": code });
  }

  function renderWithCopy(markdown: string, props: { streaming?: boolean } = {}) {
    const html = renderToStaticMarkup(
      <CodeCopyButtonContext.Provider value={ProbeCopyButton}>
        <ChatMarkdown palette={lightTokens} colorScheme="light" {...props}>
          {markdown}
        </ChatMarkdown>
      </CodeCopyButtonContext.Provider>,
    );
    return new DOMParser().parseFromString(html, "text/html");
  }

  it.each([
    ["a fence", "```ts\nconst a = 1;\n\n  return a;\n```", "const a = 1;\n\n  return a;"],
    ["a fence without a language", "```\nnpm install\n```", "npm install"],
    ["an indented block", "Run:\n\n    line one\n      line two\n", "line one\n  line two"],
    [
      "a mermaid fence shown as code",
      "```mermaid\ngraph LR\n  A --> B\n```",
      "graph LR\n  A --> B",
    ],
  ])("gives %s a copy button for its exact code", (_case, markdown, code) => {
    const document = renderWithCopy(markdown);
    const probes = document.querySelectorAll("copy-probe");
    expect(probes).toHaveLength(1);
    expect(probes[0]?.getAttribute("data-code")).toBe(code);
  });

  it("keeps the button inside the block's frame, beside the code rather than in its scroll view", () => {
    for (const markdown of ["```ts\nconst a = 1;\n```", "    const a = 1;"]) {
      const probe = renderWithCopy(markdown).querySelector("copy-probe");
      expect(probe?.closest("rn-scroll-view")).toBeNull();
      const row = probe?.parentElement;
      expect(row?.getAttribute("data-flex-direction")).toBe("row");
      expect(row?.querySelector("rn-scroll-view")).not.toBeNull();
      const frame = row?.parentElement;
      expect(frame?.getAttribute("data-border-width")).toBeTruthy();
      expect(frame?.getAttribute("data-background-color")).toBe(lightTokens.secondary);
    }
  });

  it("draws an indented block with the Text the app installs after this package loads", () => {
    // As the app's text-size cap does when it starts.
    const original = reactNativeText.current as (props: TextProps) => ReactNode;
    reactNativeText.current = (props: TextProps) =>
      createElement(original, { ...props, maxFontSizeMultiplier: MAX_FONT_SCALE });
    try {
      const html = renderToStaticMarkup(<ChatMarkdown>{"Run:\n\n    npm test"}</ChatMarkdown>);
      expect(textStyle(html, "npm test")["data-max-font-size-multiplier"]).toBe(
        String(MAX_FONT_SCALE),
      );
    } finally {
      reactNativeText.current = original;
    }
  });

  it("moves an indented block's frame off its text", () => {
    const text = renderWithCopy("    const a = 1;").querySelector("rn-scroll-view rn-text");
    expect(text?.textContent).toBe("const a = 1;");
    expect(text?.getAttribute("data-border-width")).toBeNull();
    expect(text?.getAttribute("data-background-color")).toBeNull();
  });

  it("shows the button while a reply streams", () => {
    expect(
      renderWithCopy("```ts\nconst live = true;", { streaming: true }).querySelector("copy-probe"),
    ).not.toBeNull();
  });

  it("gives inline code and an empty fence no button", () => {
    const blankFence = "```ts\n\n\n```";
    expect(renderWithCopy(blankFence).querySelector("copy-probe")).toBeNull();
    expect(markdownCodeBlocks(blankFence)).toEqual([]);
    expect(renderWithCopy("Run `npm test` first.").querySelector("copy-probe")).toBeNull();
    expect(renderWithCopy("```ts\n```").querySelector("copy-probe")).toBeNull();
  });

  it("lists the code of every block that gets a button, and nothing else", () => {
    const markdown = [
      "Run `npm test` first.",
      "```ts\nconst a = 1;\n\n  return a;\n```",
      "```\n```",
      "> ```\n> quoted\n> ```",
      "- item\n\n      indented in a list",
      "```mermaid\ngraph LR\n  A --> B\n```",
    ].join("\n\n");
    const probes = [...renderWithCopy(markdown).querySelectorAll("copy-probe")].map((probe) =>
      probe.getAttribute("data-code"),
    );
    expect(markdownCodeBlocks(markdown)).toEqual([
      "const a = 1;\n\n  return a;",
      "quoted",
      "indented in a list",
      "graph LR\n  A --> B",
    ]);
    expect(markdownCodeBlocks(markdown)).toEqual(probes);
    expect(markdownCodeBlocks("No code here, only `inline`.")).toEqual([]);
  });

  it("draws no button when the app supplies none", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{"```\nnpm test\n```"}</ChatMarkdown>);
    expect(html).not.toContain("<copy-probe");
    expect(html).toContain("npm test");
  });
});

describe("native markdown re-renders", () => {
  it("keeps a streaming reply's earlier blocks mounted as it grows", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const first = "First paragraph.\n\n```ts\nconst a = 1;\n```";
    const paragraph = () =>
      [...container.querySelectorAll("rn-text")].find(
        (text) => text.textContent === "First paragraph.",
      );
    const codeLine = () =>
      [...container.querySelectorAll("rn-text")].find(
        (text) => text.textContent === "const a = 1;",
      );
    await act(async () => {
      root.render(<ChatMarkdown streaming>{first}</ChatMarkdown>);
    });
    const before = [paragraph(), codeLine()];
    expect(before.every(Boolean)).toBe(true);
    for (const text of [`${first}\n\nMore`, `${first}\n\nMore text`]) {
      await act(async () => {
        root.render(<ChatMarkdown streaming>{text}</ChatMarkdown>);
      });
      expect([paragraph(), codeLine()].every((node, index) => node === before[index])).toBe(true);
    }

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("draws each code line as one text with its tokens inside", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown colorScheme="light">{"```ts\nconst a = 1;\nreturn a;\n```"}</ChatMarkdown>,
    );
    const rows = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelectorAll("rn-scroll-view rn-view[data-flex-direction='row']");
    expect([...rows].map((row) => row.textContent)).toEqual(["const a = 1;", "return a;"]);
    for (const row of rows) {
      expect(row.children).toHaveLength(1);
      expect(row.children[0]?.tagName.toLowerCase()).toBe("rn-text");
      expect(row.children[0]?.querySelectorAll("rn-text").length).toBeGreaterThan(1);
    }
  });
});

describe("long user messages", () => {
  const line = (index: number) => `Line ${index} ${"x".repeat(60)}`;

  it("keeps a short message whole", () => {
    expect(textBlocks("one\n\ntwo")).toEqual(["one\n\ntwo"]);
  });

  it.each([
    ["plain lines", Array.from({ length: 200 }, (_, i) => line(i)).join("\n")],
    [
      "blank lines between paragraphs",
      Array.from({ length: 120 }, (_, i) => line(i)).join("\n\n\n"),
    ],
    [
      "leading and trailing blank lines",
      `\n\n${Array.from({ length: 80 }, (_, i) => line(i)).join("\n")}\n\n`,
    ],
  ])("cuts %s at line breaks into pieces that join back exactly", (_case, text) => {
    const blocks = textBlocks(text);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join("\n")).toBe(text);
    for (const block of blocks.slice(0, -1)) {
      expect(block.endsWith("\n")).toBe(false);
      expect(block.length).toBeLessThan(1100);
    }
  });

  it("keeps a single long line whole", () => {
    const text = "y".repeat(5000);
    expect(textBlocks(text)).toEqual([text]);
  });

  it("draws a long message as stacked paragraphs with the same text and style", () => {
    const text = Array.from({ length: 60 }, (_, i) => `${line(i)} https://example.com/${i}`).join(
      "\n",
    );
    const html = renderToStaticMarkup(
      <LinkifiedText color={darkTokens.foreground} linkColor={darkTokens.link} palette={darkTokens}>
        {text}
      </LinkifiedText>,
    );
    const root = new DOMParser().parseFromString(html, "text/html").body.firstElementChild;
    expect(root?.tagName.toLowerCase()).toBe("rn-view");
    const paragraphs = [...(root?.children ?? [])];
    expect(paragraphs.length).toBe(textBlocks(text).length);
    for (const paragraph of paragraphs) {
      expect(paragraph.tagName.toLowerCase()).toBe("rn-text");
      expect(paragraph.getAttribute("data-color")).toBe(darkTokens.foreground);
    }
    expect(
      paragraphs[0]?.querySelectorAll("[data-accessibility-role='link']").length,
    ).toBeGreaterThan(0);
  });
});

describe("native markdown code colours", () => {
  it.each([
    ["dark", darkTokens, themes.oneDark],
    ["light", lightTokens, themes.oneLight],
  ] as const)("draws plain code in the %s theme's text colour", (scheme, palette, theme) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown palette={palette} colorScheme={scheme}>
        {"```bash\necho hi\n```\n\n```\nplain text\n```"}
      </ChatMarkdown>,
    );
    const code = [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("rn-text")]
      .filter((text) => /echo|hi|plain text/.test(text.textContent ?? ""))
      .filter((text) => text.children.length === 0);
    expect(code.length).toBeGreaterThan(0);
    for (const text of code) expect(text.getAttribute("data-color")).toBeTruthy();
    const plain = code.find((text) => text.textContent === "plain text");
    expect(plain?.getAttribute("data-color")).toBe(theme.plain.color);
  });
});

describe("user message links", () => {
  it("opens a link tapped inside a user message bubble's long-press pressables", async () => {
    // The mobile thread wraps a user bubble in two long-press Pressables: the
    // row, then the bubble. A tap on the address still opens it, and markdown
    // markers stay literal characters.
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    linking.openURL.mockClear();
    linking.canOpenURL.mockClear();
    const longPress = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Pressable accessible={false} onLongPress={longPress}>
          <Pressable onLongPress={longPress}>
            <LinkifiedText
              color={darkTokens.foreground}
              linkColor={darkTokens.link}
              palette={darkTokens}
            >
              {"# Title **important** https://example.com/docs"}
            </LinkifiedText>
          </Pressable>
        </Pressable>,
      );
    });

    const link = container.querySelector<HTMLElement>(
      "rn-pressable rn-pressable [data-accessibility-role='link']",
    );
    // A bare address shows as host and path, joined to its site icon.
    expect(link?.textContent).toBe("\u2060\u2068example.com/docs\u2069");
    expect(container.textContent).toContain("# Title");
    expect(container.textContent).toContain("**important**");

    await act(async () => {
      link?.click();
    });
    expect(linking.openURL).not.toHaveBeenCalled();
    await act(async () => {
      alert.mock.calls.at(-1)?.[2][1].onPress();
    });
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://example.com/docs");
    });
    expect(longPress).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("native markdown lists", () => {
  it("gives list items an intrinsic width instead of a zero flex basis", () => {
    // `flex: 1` on list content collapsed a shrink-wrapped bubble to one character wide.
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"- premier point\n- second point"}</ChatMarkdown>,
    );
    expect(html).toContain('data-flex-grow="1"');
    expect(html).not.toContain('data-flex="1"');
    expect(html).toContain("premier point");
    const ordered = renderToStaticMarkup(<ChatMarkdown>{"3. trois\n4. quatre"}</ChatMarkdown>);
    expect(ordered).toContain("3.");
    expect(ordered).toContain("4.");
    expect(ordered).not.toContain('data-flex="1"');
  });

  it("numbers an ordered list nested inside a bulleted one", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"- outer\n  1. first\n  2. second"}</ChatMarkdown>,
    );
    expect(html).toContain("1.");
    expect(html).toContain("2.");
    // One bullet for the outer item, none for the nested numbered items.
    expect(bulletDots(html)).toHaveLength(1);
  });

  it("marks bullets with a 5pt dot centred on the first line, 26pt before the text", () => {
    const dots = bulletDots(renderToStaticMarkup(<ChatMarkdown>{"- one\n- two"}</ChatMarkdown>));
    expect(dots).toHaveLength(2);
    expect(dots[0]?.getAttribute("data-border-radius")).toBe("2.5");
    // Centred on an invisible line in the body style, so it follows the text size, in a marker
    // only as tall as that line, so a wrapped item keeps its dot on the first line.
    const marker = dots[0]?.parentElement;
    expect(marker?.getAttribute("data-align-self")).toBe("flex-start");
    expect(marker?.getAttribute("data-flex-direction")).toBe("row");
    expect(marker?.getAttribute("data-align-items")).toBe("center");
    // No offset against the item: a percentage would resolve against the wrapped item's height.
    expect(dots[0]?.hasAttribute("data-position")).toBe(false);
    expect(dots[0]?.hasAttribute("data-top")).toBe(false);
    const line = dots[0]?.parentElement?.querySelector("rn-text");
    expect(line?.textContent).toBe("\u200B");
    expect(line?.getAttribute("data-line-height")).toBe("22");
    expect(line?.getAttribute("data-font-size")).toBe("17");
    // Markers sit back in the faint colour so the text leads.
    expect(dots[0]?.getAttribute("data-background-color")).toBe(darkTokens.faintForeground);
    // 13 + 5 + 8: the dot ends where a one-digit number ends.
    expect(dots[0]?.parentElement?.getAttribute("data-margin-left")).toBe("13");
    expect(dots[0]?.parentElement?.getAttribute("data-margin-right")).toBe("8");
  });

  it("draws task list items as checkboxes instead of their [ ] and [x] text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"- [x] Draft the announcement\n- [ ] Collect quotes\n- plain"}</ChatMarkdown>,
    );
    expect(html).not.toContain("[x]");
    expect(html).not.toContain("[ ]");
    expect(html).toContain("Draft the announcement");
    expect(html.match(/data-accessibility-role="checkbox"/g)).toHaveLength(2);
    expect(html.match(/✓/g)).toHaveLength(1);
    // Each task is one accessible element that reads its text with its state.
    expect(html).toMatch(/accessible=""[^>]*accessibilityLabel="Draft the announcement"/);
    // The plain item keeps its bullet.
    expect(bulletDots(html)).toHaveLength(1);
  });

  it("draws a checkbox when the task text starts on the next line", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{"- [x]\n  Ship it"}</ChatMarkdown>);
    expect(html).not.toContain("[x]");
    expect(html).toContain("Ship it");
    expect(html.match(/data-accessibility-role="checkbox"/g)).toHaveLength(1);
  });

  it("keeps each nested task's own checkbox state", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"- [ ] Launch\n  - [x] Draft\n  - [ ] Review"}</ChatMarkdown>,
    );
    expect(html.match(/data-accessibility-role="checkbox"/g)).toHaveLength(3);
    expect(html).toMatch(/accessibilityLabel="Launch"/);
    expect(html).toMatch(/accessibilityLabel="Draft"/);
  });

  it("keeps escaped [x] and [ ] as literal text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"- \\[x\\] done literally\n- \\[ \\] open literally"}</ChatMarkdown>,
    );
    expect(html).toContain("[x] done literally");
    expect(html).toContain("[ ] open literally");
    expect(html).not.toContain('data-accessibility-role="checkbox"');
    expect(bulletDots(html)).toHaveLength(2);
  });

  it("draws the bullet dot in the list-marker colour", () => {
    const markerColor = "#7A7A80";
    const create = vi
      .spyOn(StyleSheet, "create")
      // The message styles gain a list-marker colour, as a colour theme would set it.
      .mockImplementation((styles) =>
        "body" in styles ? { ...styles, bullet_list_icon: { color: markerColor } } : styles,
      );
    try {
      const dots = bulletDots(
        renderToStaticMarkup(<ChatMarkdown palette={{ ...darkTokens }}>{"- one"}</ChatMarkdown>),
      );
      expect(dots[0]?.getAttribute("data-background-color")).toBe(markerColor);
    } finally {
      create.mockRestore();
    }
  });

  it("puts a short list's numbers in an 18pt column, 8pt before the text", () => {
    const columns = numberColumns(
      renderToStaticMarkup(<ChatMarkdown>{"1. one\n2. two\n3. three"}</ChatMarkdown>),
    );
    expect(columns).toHaveLength(3);
    for (const column of columns) {
      expect(column.getAttribute("data-min-width")).toBe("18");
      expect(column.getAttribute("data-margin-right")).toBe("8");
      expect(column.getAttribute("data-align-items")).toBe("flex-end");
    }
  });

  it("widens the number column for the whole list once it reaches 10, so item text lines up", () => {
    const columns = numberColumns(
      renderToStaticMarkup(
        <ChatMarkdown>
          {Array.from({ length: 10 }, (_, i) => `${i + 1}. item`).join("\n")}
        </ChatMarkdown>,
      ),
    );
    expect(columns.map((column) => column.textContent)).toEqual(
      Array.from({ length: 10 }, (_, i) => `${i + 1}.`),
    );
    const widths = new Set(columns.map((column) => Number(column.getAttribute("data-min-width"))));
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBeGreaterThan(18);
  });

  it("separates list items by 8pt", () => {
    for (const markdown of ["- one\n- two", "1. one\n2. two"]) {
      const document = new DOMParser().parseFromString(
        renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>),
        "text/html",
      );
      const firstItem = [...document.querySelectorAll("rn-view")].find(
        (view) => isBulletDot(view.firstElementChild) || isNumberColumn(view.firstElementChild),
      );
      expect(firstItem?.parentElement?.getAttribute("data-gap")).toBe("8");
    }
  });

  // iOS font scales: the default, xxxLarge and the second accessibility size.
  it.each([
    ["10 items at the default text size", 1, 10, ".", 24],
    ["100 items at the default text size", 1, 100, ".", 33],
    ["10 items at the largest standard text size", 1.353, 10, ".", 32],
    // Text stops growing at the largest standard size, and the column with it.
    ["10 items at an accessibility text size", 2.143, 10, ".", 32],
    ["10 items numbered 1) at an accessibility text size", 2.143, 10, ")", 34],
  ])(
    "gives every number in a list of %s one column, as wide as its longest number",
    (_, fontScale, count, markup, width) => {
      windowSize.fontScale = fontScale;
      try {
        const columns = numberColumns(
          renderToStaticMarkup(
            <ChatMarkdown>
              {Array.from({ length: count }, (_, i) => `${i + 1}${markup} item`).join("\n")}
            </ChatMarkdown>,
          ),
        );
        expect(columns).toHaveLength(count);
        for (const column of columns) {
          expect(column.getAttribute("data-min-width")).toBe(String(width));
        }
      } finally {
        windowSize.fontScale = 1;
      }
    },
  );

  it("numbers ordered lists at 15pt in tabular figures", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{"9. nine\n10. ten"}</ChatMarkdown>);
    expect(textStyle(html, "10.")).toMatchObject({
      "data-font-size": "15",
      "data-line-height": "22",
      "data-font-variant": "tabular-nums",
    });
  });
});

describe("native markdown type", () => {
  it("sets bot and user message text at 17pt on a 22pt line", () => {
    const bot = renderToStaticMarkup(<ChatMarkdown>{"Plain reply."}</ChatMarkdown>);
    expect(textStyle(bot, "Plain reply.")).toMatchObject({
      "data-font-size": "17",
      "data-line-height": "22",
    });
    const user = renderToStaticMarkup(
      <LinkifiedText color={darkTokens.foreground} linkColor={darkTokens.link} palette={darkTokens}>
        {"Plain message."}
      </LinkifiedText>,
    );
    expect(textStyle(user, "Plain message.")).toMatchObject({
      "data-font-size": "17",
      "data-line-height": "22",
    });
  });

  it("draws headings and bold text in semibold", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"# One\n\n## Two\n\n### Three\n\n#### Four\n\nSome **bold** text."}
      </ChatMarkdown>,
    );
    const heading = (size: string, lineHeight: string) => ({
      "data-font-size": size,
      "data-line-height": lineHeight,
      "data-font-weight": "600",
    });
    expect(textStyle(html, "One")).toMatchObject(heading("22", "26"));
    expect(textStyle(html, "Two")).toMatchObject(heading("19", "23"));
    expect(textStyle(html, "Three")).toMatchObject(heading("17", "22"));
    expect(textStyle(html, "Four")).toMatchObject(heading("15", "19"));
    expect(textStyle(html, "bold")).toMatchObject({ "data-font-weight": "600" });
  });

  it("sets inline code in the system monospaced font at 14pt without a chip", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{"Run `pnpm test` now."}</ChatMarkdown>);
    expect(textStyle(html, "pnpm test")).toMatchObject({
      "data-font-family": "ui-monospace",
      "data-font-size": "14",
      "data-background-color": "transparent",
      "data-border-width": "0",
    });
  });

  it("sets code blocks in the system monospaced font at 14pt with the font's own line spacing, in a rounded box", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{"```\nconst a = 1;\n```"}</ChatMarkdown>);
    const document = new DOMParser().parseFromString(html, "text/html");
    const token = [...document.querySelectorAll("rn-text")].find((text) =>
      text.textContent?.includes("const"),
    );
    expect(token?.getAttribute("data-font-family")).toBe("ui-monospace");
    expect(token?.getAttribute("data-font-size")).toBe("14");
    expect(token?.hasAttribute("data-line-height")).toBe(false);
    expect(
      document.querySelector("rn-view[data-border-radius]")?.getAttribute("data-border-radius"),
    ).toBe("10");
  });

  it("sets table headers in medium and cells at 14pt on an 18pt line", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{THREE_COLUMN_TABLE}</ChatMarkdown>);
    expect(textStyle(html, "Status")).toMatchObject({
      "data-font-size": "14",
      "data-line-height": "18",
      "data-font-weight": "500",
    });
    expect(textStyle(html, "queued")).toMatchObject({
      "data-font-size": "14",
      "data-line-height": "18",
    });
  });

  it("draws a 3pt quote bar", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{"> Quoted."}</ChatMarkdown>);
    expect(html).toMatch(/data-border-left-color="[^"]+"[^>]*data-border-left-width="3"/);
  });
});

describe("native markdown images", () => {
  it("shows a remote image as a placeholder that loads it in place on tap", async () => {
    const markdown = '![chart](https://images.example.test/tap.png?d=secret "Q3 revenue")';
    const html = renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>);
    expect(html).not.toContain("<rn-stub");
    expect(html).toContain('data-accessibility-role="button"');
    expect(html).toContain('accessibilityLabel="chart, images.example.test"');
    expect(html).toContain('accessibilityHint="Q3 revenue"');
    // A filled chip on the muted bubble reads as a control in both themes.
    expect(html).toContain(`data-background-color="${darkTokens.background}"`);

    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    linking.openURL.mockClear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("rn-stub")).toBeNull();
    await act(async () => {
      container.querySelector<HTMLElement>("[data-accessibility-role='button']")?.click();
    });
    expect(container.querySelector("rn-stub")).not.toBeNull();
    expect(container.querySelector("[data-accessibility-role='button']")).toBeNull();
    expect(linking.openURL).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    container.remove();

    // The reader's choice holds for the session, so a remounted bubble keeps the image.
    expect(renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>)).toContain("<rn-stub");
  });

  it("shows a placeholder when a tapped image is replaced with another url", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const image = (href: string) => ({ href, host: "images.example.test" });
    const render = (href: string) => {
      root.render(
        <RemoteMarkdownImage
          image={image(href)}
          alt="chart"
          rejectedLink={false}
          labelStyle={undefined}
          styleMap={{}}
        />,
      );
    };
    await act(async () => {
      render("https://images.example.test/native-first.png");
    });
    await act(async () => {
      container.querySelector<HTMLElement>("[data-accessibility-role='button']")?.click();
    });
    expect(container.querySelector("rn-stub")).not.toBeNull();

    await act(async () => {
      render("https://images.example.test/native-second.png");
    });
    expect(container.querySelector("rn-stub")).toBeNull();
    expect(container.querySelector("[data-accessibility-role='button']")).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("loads remote images at once when the reader turned that on", () => {
    const html = renderToStaticMarkup(
      <RemoteImagesContext.Provider value={true}>
        <ChatMarkdown>
          {
            "![chart](https://images.example.test/auto.png) [![build](https://badge.example.test/auto.svg)](https://ci.example.test/run)"
          }
        </ChatMarkdown>
      </RemoteImagesContext.Provider>,
    );
    expect(html.match(/<rn-stub/g)).toHaveLength(2);
    expect(html).toContain('data-accessibility-role="link"');
    expect(html).not.toContain('data-accessibility-role="button"');
  });

  it("shows unopenable image sources and unsafe links as plain text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"![logo](/api/v1/p.gif) ![](example.test/p.gif) [x](javascript:alert(1))"}
      </ChatMarkdown>,
    );
    expect(html).not.toContain("<rn-stub");
    expect(html).not.toContain("data-accessibility-role");
    expect(html).not.toContain("data-text-decoration-line");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(">x</rn-text>");
    expect(html).toContain("logo");
    expect(html).toContain("example.test/p.gif");
  });

  it("lays out a linked image placeholder as a block beside the link", async () => {
    const markdown =
      "See [![build](https://badge.example.test/tap-linked.svg)](https://ci.example.test/tap-linked) now";
    const html = renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>);
    expect(html).not.toContain("<rn-stub");
    expect(html).not.toContain("tap-linked.svg");
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const button = holder.querySelector<HTMLElement>("[data-accessibility-role='button']");
    const link = holder.querySelector<HTMLElement>("[data-accessibility-role='link']");
    expect(button?.closest("rn-text")).toBeNull();
    expect(button?.closest("[data-accessibility-role='link']")).toBeNull();
    expect(button?.parentElement?.tagName.toLowerCase()).toBe("rn-view");
    expect(button?.parentElement?.getAttribute("data-flex")).toBeNull();
    expect(button?.parentElement).toBe(link?.parentElement);
    expect(link?.contains(button)).toBe(false);
    expect(link?.textContent).toBe("ci.example.test");
    expect(holder.textContent).toContain("See ");
    expect(holder.textContent).toContain(" now");

    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    linking.openURL.mockClear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("rn-stub")).toBeNull();

    const liveLink = container.querySelector<HTMLElement>("[data-accessibility-role='link']");
    await act(async () => {
      liveLink?.click();
    });
    expect(linking.openURL).not.toHaveBeenCalled();
    await act(async () => {
      alert.mock.calls.at(-1)?.[2][1].onPress();
    });
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://ci.example.test/tap-linked");
    });
    expect(container.querySelector("rn-stub")).toBeNull();

    linking.openURL.mockClear();
    const liveButton = container.querySelector<HTMLElement>("[data-accessibility-role='button']");
    expect(liveButton?.closest("[data-accessibility-role='link']")).toBeNull();
    await act(async () => {
      liveButton?.click();
    });
    const image = container.querySelector("rn-stub");
    expect(image).not.toBeNull();
    expect(image?.closest("[data-accessibility-role='link']")).not.toBeNull();
    expect(container.querySelector("[data-accessibility-role='button']")).toBeNull();
    expect(linking.openURL).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps an image inside a rejected link as text when automatic loading is on", () => {
    const html = renderToStaticMarkup(
      <RemoteImagesContext.Provider value={true}>
        <ChatMarkdown>
          {
            "[![Open](https://example.test/visit)](javascript:alert(1)) [![File](https://example.test/file)](data:text/html,hi)"
          }
        </ChatMarkdown>
      </RemoteImagesContext.Provider>,
    );
    expect(html).not.toContain("<rn-stub");
    expect(html).not.toContain("example.test");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(`data-color="${darkTokens.foreground}">Open</rn-text>`);
    expect(html).toContain(`data-color="${darkTokens.foreground}">File</rn-text>`);
  });

  it("shows an image inside a rejected link as plain text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {
          "[![Open](https://example.test/visit)](javascript:alert(1)) [![File](https://example.test/file)](data:text/html,hi)"
        }
      </ChatMarkdown>,
    );
    expect(html).not.toContain("<rn-stub");
    expect(html).not.toContain("<rn-pressable");
    expect(html).not.toContain("data-accessibility-role");
    expect(html).not.toContain("data-text-decoration-line");
    expect(html).not.toContain("example.test");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(`data-color="${darkTokens.foreground}">Open</rn-text>`);
    expect(html).toContain(`data-color="${darkTokens.foreground}">File</rn-text>`);
  });

  it("shows mailto and tel image sources as plain text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"![Contact](mailto:user@example.test) ![Call](tel:+15551212)"}</ChatMarkdown>,
    );
    expect(html).not.toContain("data-accessibility-role");
    expect(html).not.toContain("data-text-decoration-line");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("tel:");
    expect(html).toContain("Contact");
    expect(html).toContain("Call");
  });

  it("shows an image-only link with an unopenable destination as plain text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"[![build](https://badge.example.test/b.svg)](/run)"}</ChatMarkdown>,
    );
    expect(html).not.toContain("<rn-pressable");
    expect(html).not.toContain("data-accessibility-role");
    expect(html).not.toContain("data-text-decoration-line");
    expect(html).not.toContain("badge.example.test");
    expect(html).toContain("build");
    // The label sits outside any text node, so it must carry the body color itself.
    expect(html).toContain(`data-color="${darkTokens.foreground}">build</rn-text>`);
  });

  it("renders embedded image data inline", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"![dot](data:image/png;base64,iVBORw0KGgo=)"}</ChatMarkdown>,
    );
    // The image component is a stub under test; a link would mean it fell back.
    expect(html).toContain("<rn-stub");
    expect(html).not.toContain("data-accessibility-role");
  });
});

describe("message direction", () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
  const directionAttributes =
    /data-text-align|data-writing-direction|data-flex-direction="row-reverse"/;

  function userBubble(text: string) {
    const html = renderToStaticMarkup(
      <LinkifiedText color={darkTokens.foreground} linkColor={darkTokens.link} palette={darkTokens}>
        {text}
      </LinkifiedText>,
    );
    return { html, root: parse(html).querySelector("rn-text") };
  }

  function botTextGroups(markdown: string) {
    const document = parse(renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>));
    // A text group is the outermost text of a block; its leaves are nested texts.
    const groups = [...document.querySelectorAll("rn-text")].filter(
      (text) => text.parentElement?.tagName.toLowerCase() !== "rn-text",
    );
    return { document, groups };
  }

  function textOf(element: Element | null | undefined) {
    return element?.textContent ?? "";
  }

  it("right-aligns a user message whose first letter is Hebrew or Arabic", () => {
    for (const text of [
      "שלום! זה מבחן של טקסט בעברית בלבד, עם סימני פיסוק בסוף.",
      "2026: مرحبا بالعالم، هذه رسالة طويلة بما يكفي لتلتف.",
      "«שלום», see the CHANGELOG sentence.",
    ]) {
      const { root } = userBubble(text);
      expect(root?.getAttribute("data-text-align")).toBe("right");
      // iOS already shapes each paragraph by its own first letter.
      expect(root?.hasAttribute("data-writing-direction")).toBe(false);
    }
  });

  it("leaves Latin, CJK and messages that start in English as they were", () => {
    for (const text of ["Hello there.", "你好，世界。", "Translate: שלום", "😀 123 !!", ""]) {
      expect(userBubble(text).html).not.toMatch(directionAttributes);
    }
  });

  it("aligns each bot block by its own first letter", () => {
    const { groups } = botTextGroups(
      [
        "Fake reply 9. You said:",
        "",
        "## כותרת",
        "",
        "רשימה קצרה.",
        "",
        "See README.md.",
        "",
        "> ציטוט",
      ].join("\n"),
    );
    const alignment = Object.fromEntries(
      groups.map((group) => [
        textOf(group),
        [group.getAttribute("data-text-align"), group.getAttribute("data-width")],
      ]),
    );
    expect(alignment).toEqual({
      "Fake reply 9. You said:": [null, null],
      כותרת: ["right", "100%"],
      "רשימה קצרה.": ["right", "100%"],
      "See README.md.": [null, null],
      ציטוט: ["right", "100%"],
    });
  });

  it("puts each list item's marker on its own side", () => {
    const { document } = botTextGroups(
      "- פריט ראשון\n- Install the CLI.\n\n1. אחד\n2. second\n3. שלוש",
    );
    const items = [...document.querySelectorAll("rn-view")].filter((view) => {
      const marker = view.firstElementChild;
      return isBulletDot(marker) || isNumberColumn(marker);
    });
    expect(
      items.map((item) => [
        textOf(item.lastElementChild),
        item.getAttribute("data-flex-direction"),
        item.firstElementChild?.querySelector("rn-text")?.getAttribute("data-writing-direction") ??
          null,
      ]),
    ).toEqual([
      ["פריט ראשון", "row-reverse", "rtl"],
      ["Install the CLI.", "row", null],
      ["אחד", "row-reverse", "rtl"],
      ["second", "row", null],
      ["שלוש", "row-reverse", "rtl"],
    ]);
  });

  it("renders an English block in a Hebrew-first reply the same as on its own", () => {
    const englishItem = (markdown: string) =>
      [...botTextGroups(markdown).document.querySelectorAll("rn-view")]
        .filter(
          (view) =>
            isBulletDot(view.firstElementChild) &&
            textOf(view.lastElementChild) === "Install the CLI.",
        )
        .map((view) => view.outerHTML);
    const englishParagraph = (markdown: string) =>
      botTextGroups(markdown)
        .groups.filter((group) => textOf(group) === "See README.md.")
        .map((group) => group.outerHTML);
    const mixed = "שלום רב.\n\n- פריט ראשון\n- Install the CLI.\n\nSee README.md.";
    expect(englishItem(mixed)).toEqual(englishItem("- Install the CLI."));
    expect(englishParagraph(mixed)).toEqual(englishParagraph("See README.md."));
    expect(englishItem(mixed)).toHaveLength(1);
  });

  it("keeps code in a right-to-left message as it was", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"שלום\n\n    indented();\n\n```\nfenced();\n```"}</ChatMarkdown>,
    );
    const code = [...parse(html).querySelectorAll("rn-text")].filter((text) =>
      /indented|fenced/.test(textOf(text)),
    );
    expect(code.length).toBeGreaterThan(0);
    for (const text of code) expect(text.outerHTML).not.toMatch(directionAttributes);
  });

  it("fills code blocks with the secondary fill, not the page colour", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"    indented();\n\n```\nfenced();\n```"}</ChatMarkdown>,
    );
    expect(html).toContain(`data-background-color="${darkTokens.secondary}"`);
    expect(html).not.toContain(`data-background-color="${darkTokens.background}"`);
  });

  it("fills a fence once, so its header and code do not stack the translucent fill", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{"```ts\nfenced();\n```"}</ChatMarkdown>);
    expect(html.split(`data-background-color="${darkTokens.secondary}"`)).toHaveLength(2);
  });

  it("keeps a left-to-right bot message laid out as before", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"## Heading\n\nIntro שלום.\n\n- one\n- two\n\n1. first\n2. second"}
      </ChatMarkdown>,
    );
    expect(html).not.toMatch(directionAttributes);
  });

  it("aligns an English message to the far side in a right-to-left app", () => {
    i18n.isRTL = true;
    try {
      // React Native mirrors `right` in a right-to-left layout, so it lands on the left.
      expect(userBubble("Hello there.").root?.getAttribute("data-text-align")).toBe("right");
      expect(userBubble("שלום").html).not.toMatch(directionAttributes);
      const { document } = botTextGroups("1. Install the CLI.");
      expect(document.querySelector('rn-view[data-flex-direction="row-reverse"]')).not.toBeNull();
      expect(document.querySelector('rn-text[data-writing-direction="ltr"]')).not.toBeNull();
    } finally {
      i18n.isRTL = false;
    }
  });
});

const ICON = "data:image/png;base64,iVBORw0KGgo=";
// Word joiner, then the label wrapped in a first-strong isolate.
const joined = (label: string) => `\u2060\u2068${label}\u2069`;

async function renderNativeLinks(
  node: (streaming: boolean) => ReactNode,
  favicons: LinkFavicons,
  streaming = false,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (nextStreaming: boolean) => {
    await act(async () => {
      root.render(
        <LinkFaviconsContext.Provider value={favicons}>
          {node(nextStreaming)}
        </LinkFaviconsContext.Provider>,
      );
    });
  };
  await render(streaming);
  return {
    container,
    render,
    links: () => [
      ...container.querySelectorAll<HTMLElement>("rn-text[data-accessibility-role='link']"),
    ],
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("native website links", () => {
  const globe = createElement("rn-globe");

  it("draws the API's icon in a hidden tile joined to the author's label", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await renderNativeLinks(
      () => (
        <ChatMarkdown>{"Traffic plunges. [Post](https://native-a.example.test/p/1)"}</ChatMarkdown>
      ),
      { load, globe },
    );
    const [link] = view.links();
    expect(link?.getAttribute("data-accessibility-label")).toBe("Post");
    expect(link?.textContent).toBe(joined("Post"));
    const marker = link?.querySelector("rn-view");
    expect(marker?.getAttribute("data-accessibility-elements-hidden")).toBe("true");
    expect(marker?.getAttribute("data-important-for-accessibility")).toBe("no-hide-descendants");
    expect(marker?.querySelector("rn-image")).not.toBeNull();
    expect(
      marker
        ?.querySelector("rn-view[data-background-color]")
        ?.getAttribute("data-background-color"),
    ).toBe(darkTokens.faviconPlate);
    // The underline sits on the label, not the tile.
    expect(link?.getAttribute("data-color")).toBe(darkTokens.foreground);
    expect(link?.getAttribute("data-text-decoration-line")).toBe("none");
    expect(load).toHaveBeenCalledWith("https://native-a.example.test");
    await view.cleanup();
  });

  it("shortens a bare URL to host and path", async () => {
    const view = await renderNativeLinks(
      () => <ChatMarkdown>{"See https://www.native-b.example.test/status/9?s=1 now"}</ChatMarkdown>,
      { load: async () => ({ icon: null }), globe },
    );
    const [link] = view.links();
    expect(link?.getAttribute("data-accessibility-label")).toBe("native-b.example.test/status/9");
    expect(link?.textContent).toBe(joined("native-b.example.test/status/9"));
    await view.cleanup();
  });

  it("shows the app's globe when there is no icon or the icon is a 1×1 pixel", async () => {
    const view = await renderNativeLinks(
      () => (
        <ChatMarkdown>
          {"[A](https://native-c.example.test/) [B](https://native-d.example.test/)"}
        </ChatMarkdown>
      ),
      {
        load: async (origin) => ({
          icon: origin === "https://native-c.example.test" ? null : ICON,
        }),
        globe,
      },
    );
    const [first, second] = view.links();
    expect(first?.querySelector("rn-globe")).not.toBeNull();
    expect(second?.querySelector("rn-image")).not.toBeNull();
    await act(async () => {
      imageLoads.at(-1)?.({ nativeEvent: { source: { width: 1, height: 1 } } });
    });
    expect(view.links()[1]?.querySelector("rn-image")).toBeNull();
    expect(view.links()[1]?.querySelector("rn-globe")).not.toBeNull();
    await view.cleanup();
  });

  it("shortens and cleans bare URLs whose escapes the parser decoded", async () => {
    const view = await renderNativeLinks(
      () => (
        <ChatMarkdown>
          {
            "See https://bidi.example.test/%E2%80%AEtxt.exe and https://native-k.example.test/caf%C3%A9 now"
          }
        </ChatMarkdown>
      ),
      { load: async () => ({ icon: null }), globe },
    );
    const [bidi, cafe] = view.links();
    expect(bidi?.getAttribute("data-accessibility-label")).toBe("bidi.example.test/txt.exe");
    expect(bidi?.textContent).toBe(joined("bidi.example.test/txt.exe"));
    expect(cafe?.textContent).toBe(joined("native-k.example.test/café"));
    expect(view.container.textContent).not.toContain("\u202E");
    await view.cleanup();
  });

  it("isolates a label so its direction characters stay inside the link", async () => {
    const view = await renderNativeLinks(
      () => (
        <ChatMarkdown>
          {
            "See [\u202Eevil](https://native-j.example.test/) then [next](https://native-j.example.test/n)"
          }
        </ChatMarkdown>
      ),
      { load: async () => ({ icon: null }), globe },
    );
    const [evil, next] = view.links();
    expect(evil?.textContent).toBe(joined("\u202Eevil"));
    expect(next?.textContent).toBe(joined("next"));
    await view.cleanup();
  });

  it("keeps formatting inside a labelled link in the website link style", async () => {
    const view = await renderNativeLinks(
      () => <ChatMarkdown>{"[**Bold** label](https://native-h.example.test/)"}</ChatMarkdown>,
      { load: async () => ({ icon: null }), globe },
    );
    const [link] = view.links();
    // The innermost text run, which carries the style the renderer gives text inside a link.
    const bold = [...(link?.querySelectorAll("rn-text") ?? [])]
      .filter((text) => text.textContent === "Bold")
      .at(-1);
    expect(bold?.getAttribute("data-color")).toBe(darkTokens.foreground);
    expect(bold?.getAttribute("data-text-decoration-line")).toBe("underline");
    expect(bold?.getAttribute("data-font-weight")).toBe("600");
    const plain = [...(link?.querySelectorAll("rn-text") ?? [])]
      .filter((text) => text.textContent === " label")
      .at(-1);
    expect(plain?.getAttribute("data-font-weight")).toBe("500");
    await view.cleanup();
  });

  it("shows the globe and does not ask again right away after a failed lookup", async () => {
    const load = vi.fn(async () => {
      throw new Error("Not found");
    });
    const markdown = "[A](https://native-i.example.test/) and [B](https://native-i.example.test/b)";
    const view = await renderNativeLinks(() => <ChatMarkdown>{markdown}</ChatMarkdown>, {
      load,
      globe,
    });
    expect(view.container.querySelectorAll("rn-globe")).toHaveLength(2);
    await view.render(false);
    await view.cleanup();
    const again = await renderNativeLinks(() => <ChatMarkdown>{markdown}</ChatMarkdown>, {
      load,
      globe,
    });
    expect(again.container.querySelectorAll("rn-globe")).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(1);
    await again.cleanup();
  });

  it("asks for no icon while a reply streams", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await renderNativeLinks(
      (streaming) => (
        <ChatMarkdown streaming={streaming}>
          {"Partial https://native-e.example.test/x"}
        </ChatMarkdown>
      ),
      { load, globe },
      true,
    );
    expect(load).not.toHaveBeenCalled();
    await view.render(false);
    expect(load).toHaveBeenCalledWith("https://native-e.example.test");
    await view.cleanup();
  });

  it("gives no tile to links that are not websites", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await renderNativeLinks(
      () => (
        <ChatMarkdown>
          {[
            "[mail](mailto:someone@example.com) [call](tel:+15555550100) [docs](/docs)",
            "`https://native-f.example.test/in-code`",
            "[![build](https://badge.example.test/b.svg)](https://native-f.example.test/ci)",
          ].join("\n\n")}
        </ChatMarkdown>
      ),
      { load, globe },
    );
    expect(view.container.querySelector("rn-globe")).toBeNull();
    expect(view.container.querySelector("rn-image")).toBeNull();
    expect(load).not.toHaveBeenCalled();
    // Links that are not websites keep the plain link style.
    const mail = view.links().find((link) => link.textContent === "mail");
    expect(mail?.getAttribute("data-color")).toBe(darkTokens.link);
    await view.cleanup();
  });

  it("underlines a user-message link in the bubble's text colour", () => {
    const html = renderToStaticMarkup(
      <LinkifiedText
        color={darkTokens.chatUserForeground}
        linkColor={darkTokens.chatUserForeground}
        palette={darkTokens}
      >
        {"see https://example.com/docs"}
      </LinkifiedText>,
    );
    expect(html).toContain(
      `data-text-decoration-line="underline" data-text-decoration-color="${darkTokens.chatUserForeground}"`,
    );
    expect(html).not.toContain(`data-text-decoration-color="${darkTokens.input}"`);
  });

  it("draws the tile in user messages, in the message's own colour", async () => {
    const view = await renderNativeLinks(
      () => (
        <LinkifiedText
          color={lightTokens.secondaryForeground}
          linkColor={lightTokens.link}
          palette={lightTokens}
        >
          {"look https://native-g.example.test/a/ or mail me@example.com"}
        </LinkifiedText>
      ),
      { load: async () => ({ icon: ICON }), globe },
    );
    const [site, mail] = view.links();
    expect(site?.getAttribute("data-accessibility-label")).toBe("native-g.example.test/a");
    expect(site?.getAttribute("data-color")).toBe(lightTokens.secondaryForeground);
    expect(site?.querySelector("rn-image")).not.toBeNull();
    expect(mail?.textContent).toBe("me@example.com");
    expect(mail?.querySelector("rn-view")).toBeNull();
    expect(mail?.getAttribute("data-color")).toBe(lightTokens.link);
    await view.cleanup();
  });
});

describe("native external link confirmation", () => {
  async function renderMarkdown(markdown: string, appOrigin?: string) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    linking.openURL.mockClear();
    alert.mockClear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const body = <ChatMarkdown>{markdown}</ChatMarkdown>;
    await act(async () => {
      root.render(
        appOrigin ? (
          <MarkdownLinkPromptProvider appOrigin={appOrigin}>{body}</MarkdownLinkPromptProvider>
        ) : (
          body
        ),
      );
    });
    return {
      container,
      async cleanup() {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
    };
  }

  it("asks before an external link and leaves it closed on cancel", async () => {
    const view = await renderMarkdown("[Docs](https://example.test/docs?x=1)");
    await act(async () => {
      view.container.querySelector<HTMLElement>("[data-accessibility-role='link']")?.click();
    });
    expect(alert).toHaveBeenCalledWith(
      "Open external link?",
      "example.test\n\nhttps://example.test/docs?x=1",
      expect.any(Array),
      { cancelable: true },
    );
    expect(alert.mock.calls.at(-1)?.[2][0]).toMatchObject({ text: "Cancel", style: "cancel" });
    expect(linking.openURL).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("Open external link?");
    await view.cleanup();
  });

  it("opens mailto and tel without asking", async () => {
    const view = await renderMarkdown("[mail](mailto:user@example.test) [call](tel:+15551212)");
    const links = view.container.querySelectorAll<HTMLElement>("[data-accessibility-role='link']");
    expect(links).toHaveLength(2);
    await act(async () => {
      links[0]?.click();
    });
    await act(async () => {
      links[1]?.click();
    });
    expect(view.container.textContent).not.toContain("Open external link?");
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("mailto:user@example.test");
      expect(linking.openURL).toHaveBeenCalledWith("tel:+15551212");
    });
    await view.cleanup();
  });

  it("opens a same-origin link without asking", async () => {
    const view = await renderMarkdown(
      "[thread](https://app.example.test/threads/1)",
      "https://app.example.test",
    );
    await act(async () => {
      view.container.querySelector<HTMLElement>("[data-accessibility-role='link']")?.click();
    });
    expect(view.container.textContent).not.toContain("Open external link?");
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://app.example.test/threads/1");
    });
    await view.cleanup();
  });
});

describe("native trusted link sites", () => {
  async function renderTrusted(markdown: string, trustedSites: string[], trustSite = vi.fn()) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    linking.openURL.mockClear();
    alert.mockClear();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownLinkPromptProvider trustedSites={trustedSites} trustSite={trustSite}>
          <ChatMarkdown>{markdown}</ChatMarkdown>
        </MarkdownLinkPromptProvider>,
      );
    });
    const link = () => container.querySelector<HTMLElement>("[data-accessibility-role='link']");
    return { link, unmount: () => act(async () => root.unmount()) };
  }

  it("opens the link and trusts its site from the third button", async () => {
    const trustSite = vi.fn(async () => {
      throw new Error("offline");
    });
    const view = await renderTrusted("[Docs](https://docs.example.test/a)", [], trustSite);
    await act(async () => {
      view.link()?.click();
    });
    const buttons = alert.mock.calls.at(-1)![2] as Array<{ text: string; onPress?: () => void }>;
    expect(buttons.map((button) => button.text)).toEqual([
      "Cancel",
      "Always open example.test",
      "Open",
    ]);
    await act(async () => {
      buttons[1]!.onPress?.();
    });
    // A failed save still opens the link.
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://docs.example.test/a");
    });
    expect(trustSite).toHaveBeenCalledWith("https://docs.example.test/a");
    await view.unmount();
  });

  it("opens a link to a trusted site directly", async () => {
    const view = await renderTrusted("[Docs](https://docs.example.test/a)", ["example.test"]);
    await act(async () => {
      view.link()?.click();
    });
    expect(alert).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://docs.example.test/a");
    });
    await view.unmount();
  });
});

it("shows a full long native URL and opens it only on confirmation", async () => {
  const url = `https://example.test/${"a".repeat(10000)}`;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  alert.mockClear();
  linking.openURL.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<ChatMarkdown>{`[Docs](${url})`}</ChatMarkdown>);
  });
  await act(async () => {
    container.querySelector<HTMLElement>("[data-accessibility-role='link']")?.click();
  });
  const [title, message, buttons, options] = alert.mock.calls.at(-1)!;
  expect(title).toBe("Open external link?");
  expect(message).toBe(`example.test\n\n${url}`);
  expect(buttons.map((button: { text: string }) => button.text)).toEqual(["Cancel", "Open"]);
  expect(options).toEqual({ cancelable: true });
  expect(linking.openURL).not.toHaveBeenCalled();
  await act(async () => {
    buttons[1].onPress();
  });
  expect(linking.openURL).toHaveBeenCalledWith(url);
  await act(async () => {
    root.unmount();
  });
});

describe("native markdown diagrams", () => {
  const FLOW = "```mermaid\ngraph LR\n  A[Clone] --> B[Branch]\n```";

  // Stands in for the app's WebView, recording what the renderer hands it.
  function ProbeDiagram({ source, palette, colorScheme, fallback }: MermaidDiagramProps) {
    return createElement(
      "diagram-probe",
      { "data-source": source, "data-scheme": colorScheme, "data-foreground": palette.foreground },
      fallback,
    );
  }

  function renderWithDiagrams(markdown: string, props: { streaming?: boolean } = {}) {
    return renderToStaticMarkup(
      <MermaidDiagramContext.Provider value={ProbeDiagram}>
        <ChatMarkdown palette={lightTokens} colorScheme="light" {...props}>
          {markdown}
        </ChatMarkdown>
      </MermaidDiagramContext.Provider>,
    );
  }

  it("hands a mermaid fence to the app's diagram with its code block as the fallback", () => {
    const html = renderWithDiagrams(FLOW);
    const document = new DOMParser().parseFromString(html, "text/html");
    const probe = document.querySelector("diagram-probe");
    expect(probe?.getAttribute("data-source")).toBe("graph LR\n  A[Clone] --> B[Branch]");
    expect(probe?.getAttribute("data-scheme")).toBe("light");
    expect(probe?.getAttribute("data-foreground")).toBe(lightTokens.foreground);
    expect(probe?.textContent).toContain("A[Clone] --> B[Branch]");
  });

  it("keeps the code block when the app supplies no diagram", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{FLOW}</ChatMarkdown>);
    expect(html).not.toContain("<diagram-probe");
    expect(html).toContain("A[Clone] --&gt; B[Branch]");
  });

  it("keeps the code block while the reply streams", () => {
    const html = renderWithDiagrams(FLOW, { streaming: true });
    expect(html).not.toContain("<diagram-probe");
    expect(html).toContain("A[Clone] --&gt; B[Branch]");
  });

  it("leaves other fences and an empty mermaid fence as code", () => {
    expect(renderWithDiagrams("```ts\nconst a = 1;\n```")).not.toContain("<diagram-probe");
    expect(renderWithDiagrams("```mermaid\n\n```")).not.toContain("<diagram-probe");
  });
});

describe("native markdown page links", () => {
  it("draws a page link as a chip that opens the page, or as its title without a handler", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    linking.openURL.mockClear();
    const openPage = vi.fn();
    const markdown =
      "See [Duplex voice](page:page_1) and [x](javascript:alert(1)) and [z](page:a/b)";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown onOpenPage={openPage}>{markdown}</ChatMarkdown>);
    });
    const links = [...container.querySelectorAll<HTMLElement>("[data-accessibility-role='link']")];
    expect(links.map((link) => link.textContent)).toEqual(["Duplex voice"]);
    expect(links[0]!.querySelector("rn-view")).not.toBeNull();
    expect(links[0]!.querySelector("[data-text-decoration-line='underline']")?.textContent).toBe(
      "Duplex voice",
    );
    await act(async () => {
      links[0]!.click();
    });
    expect(openPage).toHaveBeenCalledWith("page_1");
    expect(linking.openURL).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalledWith(expect.anything(), "page:page_1", expect.anything());

    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("[data-accessibility-role='link']")).toBeNull();
    expect(container.textContent).toContain("See Duplex voice and x and z");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
