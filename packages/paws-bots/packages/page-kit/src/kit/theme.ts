import { pageKitPalette, webDarkTokens, webLightTokens } from "@rakazo/ui-tokens";
import { useSyncExternalStore } from "react";
import type { DiagramEdge, DiagramNode } from "./diagram.js";
import { layoutDiagram } from "./diagram.js";

type Kind = "light" | "dark";

const FONT =
  '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",sans-serif';
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const type = (fontSize: number, lineHeight: number, letterSpacing: string) => ({
  fontSize: `${fontSize}px`,
  lineHeight: `${lineHeight}px`,
  letterSpacing,
});
const FONT_TOKENS = {
  family: FONT,
  mono: MONO,
  heading1: type(30, 36, "-0.4px"),
  heading2: type(24, 30, "-0.25px"),
  heading3: type(20, 26, "-0.1px"),
  body1: type(16, 24, "0.1px"),
  subtext: type(14, 20, "0.1px"),
  table: type(15, 22, "0.1px"),
  metric: type(24, 30, "-0.25px"),
  body2: type(13, 18, "0.015em"),
  label: type(12, 16, "0.01em"),
  caption: type(11, 16, "0.01em"),
  code: type(13, 20, "0"),
};
const SUBTLE_ALPHA = { dark: "2c", light: "17" };

function themeFor(kind: Kind) {
  const web = kind === "light" ? webLightTokens : webDarkTokens;
  const tone = pageKitPalette[kind];
  const ink = web.foreground.slice(0, 7);
  const alpha = SUBTLE_ALPHA[kind];
  const categorical = [tone.c1, tone.c2, tone.c3, tone.c4, tone.c5];
  return {
    kind,
    bg: { base: web.background, subtle: web.muted, elevated: web.card },
    text: {
      primary: ink,
      secondary: `${ink}99`,
      tertiary: `${ink}66`,
      onColor: pageKitPalette.shared.onColor,
      onPrimary: web.primaryForeground,
      accent: tone.accent,
      success: tone.success,
      warning: tone.warning,
      danger: tone.danger,
      accentDeep: tone.accentDeep,
      successDeep: tone.successDeep,
      warningDeep: tone.warningDeep,
      dangerDeep: tone.dangerDeep,
    },
    fill: {
      primary: web.primary,
      primaryHover: web.primaryHover,
      secondary: `${tone.other}${alpha}`,
      hover: `${ink}${kind === "light" ? "0f" : "14"}`,
      pressed: `${ink}${kind === "light" ? "17" : "1f"}`,
      accent: tone.c1,
      accentSubtle: `${tone.c1.slice(0, 7)}${alpha}`,
      successSubtle: `${tone.success.slice(0, 7)}${alpha}`,
      warningSubtle: `${tone.warning.slice(0, 7)}${alpha}`,
      dangerSubtle: `${tone.danger.slice(0, 7)}${alpha}`,
    },
    border: {
      subtle: `${ink}0d`,
      weak: `${ink}1a`,
      default: `${ink}26`,
      strong: `${ink}4d`,
      focus: `${ink}66`,
    },
    font: FONT_TOKENS,
    weight: { regular: 400, medium: 500, semibold: 600 },
    radius: { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 },
    motion: { hover: "140ms", easing: "ease" },
    dataviz: {
      categorical,
      other: tone.other,
      negative: tone.danger,
      singleSeriesRest: tone.rest,
      areaAlpha: Number(tone.area),
      sequential: [tone.seq1, tone.seq2, tone.seq3, tone.seq4, tone.seq5],
      diverging: [tone.div1, tone.div2, tone.div3, tone.div4, tone.div5],
    },
    chart: [
      ink,
      `${ink}66`,
      `color-mix(in srgb, ${ink}66 45%, transparent)`,
      `${tone.other}${alpha}`,
    ],
  };
}

type PageTheme = ReturnType<typeof themeFor>;
const THEMES: Record<Kind, PageTheme> = { dark: themeFor("dark"), light: themeFor("light") };

// The print dialog announces itself before print media applies, so both count.
let printRequested = false;
const printing = () =>
  printRequested || (typeof matchMedia === "function" && matchMedia("print").matches);

// Print styles turn the page light, so colours drawn from these values turn with it.
const currentKind = (): Kind =>
  typeof document !== "undefined" &&
  (document.documentElement.dataset.theme === "light" || printing())
    ? "light"
    : "dark";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const print = typeof matchMedia === "function" ? matchMedia("print") : null;
  print?.addEventListener("change", onChange);
  const before = () => {
    printRequested = true;
    onChange();
  };
  const after = () => {
    printRequested = false;
    onChange();
  };
  window.addEventListener("beforeprint", before);
  window.addEventListener("afterprint", after);
  return () => {
    observer.disconnect();
    print?.removeEventListener("change", onChange);
    window.removeEventListener("beforeprint", before);
    window.removeEventListener("afterprint", after);
  };
}

/** The page's colours, type and radii as values, so hand-drawn elements match the kit. */
export function useTheme(): PageTheme {
  const kind = useSyncExternalStore(subscribe, currentKind, () => "dark" as Kind);
  return THEMES[kind];
}

/** The automatic flow layout the Diagram uses, for pages that draw their own. */
export function computeDAGLayout(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  options?: { direction?: "vertical" | "horizontal" },
) {
  return layoutDiagram(
    Array.isArray(nodes) ? nodes : [],
    Array.isArray(edges) ? edges : [],
    options?.direction === "horizontal",
    true,
  );
}

type SourceRecord = {
  value: unknown;
  asOf?: string;
  fresh: false;
  updating: false;
  error?: string;
};

/**
 * Live sources are not offered yet: a page that declares them gets its bundled snapshot back,
 * labelled as not fresh, so pages written for them still render.
 */
export function useSource(id: string): SourceRecord {
  const declared = (globalThis as { __rakazoPageSources?: Record<string, unknown> })
    .__rakazoPageSources;
  if (!declared || !Object.hasOwn(declared, id)) {
    throw new Error(`useSource("${id}"): this page declares no source with that id.`);
  }
  const record = declared[id] as { value?: unknown; snapshot?: unknown; asOf?: string } | null;
  return {
    value: record && typeof record === "object" ? (record.value ?? record.snapshot) : record,
    asOf: record && typeof record === "object" ? record.asOf : undefined,
    fresh: false,
    updating: false,
  };
}
