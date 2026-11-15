import type { ComponentProps, ComponentType } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PageKitComponentName } from "../components.js";
import { PAGE_KIT_COMPONENTS } from "../components.js";
import * as calendar from "./calendar.js";
import * as charts from "./charts.js";
import * as controls from "./controls.js";
import * as data from "./data.js";
import * as dataviz from "./dataviz.js";
import * as diagram from "./diagram.js";
import * as layout from "./layout.js";
import * as media from "./media.js";
import * as text from "./text.js";

const modules = { ...calendar, ...charts, ...controls, ...data, ...dataviz, ...diagram, ...layout };
const kit = { ...modules, ...media, ...text };
type Props<K extends PageKitComponentName> = ComponentProps<(typeof kit)[K]>;

// Every list or object prop of the kit, with the fields its items carry. A page's code is
// written by a model, so any of them can arrive as null, a bare value or half-filled items.
const SHAPED: { [K in PageKitComponentName]?: { [P in keyof Props<K>]?: readonly string[] } } = {
  Page: { palette: [], sources: [] },
  Metrics: { metrics: ["value", "label", "tone", "detail", "delta", "better", "trend"] },
  Properties: { items: ["label", "value"] },
  Rows: { rows: ["title", "lead", "detail", "meta", "status"] },
  Steps: { steps: ["title", "detail"] },
  Checklist: { items: ["text", "done", "meta"] },
  Table: { columns: [], rows: [], align: [] },
  Segmented: { options: ["value", "label", "count"] },
  LineChart: {
    points: ["label", "value"],
    lines: ["label", "values"],
    secondary: ["label", "values"],
    labels: [],
    annotations: ["at", "label", "line", "value"],
  },
  Bars: { bars: ["label", "value", "display"] },
  Pie: { parts: ["label", "value", "display"] },
  Diagram: {
    nodes: ["id", "label", "detail", "kind", "series"],
    edges: ["from", "to", "label", "dashed"],
  },
  TableOfContents: { items: ["label", "id", "depth"] },
  BulletList: { items: ["text", "items", "bullets"] },
  NumberedList: { items: ["text", "items", "bullets"] },
  ProsCons: { pros: ["text", "items", "bullets"], cons: ["text", "items", "bullets"] },
  LinkCards: { links: ["title", "href", "site", "date"] },
  Legend: { names: [], comparison: [] },
  Columns: { points: ["label", "value", "display"] },
  ColumnSeries: { labels: [], series: ["name", "values"], reference: ["value", "label"] },
  StackedBars: { series: [], bars: ["label", "values", "display"] },
  Scatter: {
    points: ["x", "y", "size", "label", "series"],
    x: ["name", "unit", "floor", "ceiling"],
    y: ["name", "unit", "floor", "ceiling"],
    size: ["name"],
  },
  Heatmap: { rows: [], columns: [], values: [] },
  CalendarHeatmap: { days: ["date", "value"] },
  Venn: { sets: ["label", "count", "items"] },
  Matrix2x2: { axes: ["x", "y"], quadrants: [], points: ["label", "x", "y"] },
  SourceStamp: { source: ["value", "asOf", "fresh", "updating", "error"] },
  Select: { options: ["value", "label"] },
  Gallery: { photos: ["src", "alt"] },
  PhotoStrip: { items: ["image", "alt", "title", "href", "price", "note"] },
  ProductCard: { photos: [] },
  ProductRows: {
    items: [
      "title",
      "href",
      "image",
      "alt",
      "price",
      "note",
      "badge",
      "store",
      "rating",
      "reviews",
    ],
  },
  AvatarStack: { people: ["name"] },
  MonthView: { events: ["title", "free", "selected", "date"] },
  WeekView: { events: ["title", "free", "selected", "date", "start", "end"] },
  DayView: { events: ["title", "free", "selected", "start", "end"], mark: ["at"] },
};

// Components whose props are all text, numbers, flags, callbacks or children.
const PLAIN = new Set<PageKitComponentName>([
  "Section",
  "Grid",
  "Text",
  "Callout",
  "Status",
  "PageHero",
  "PageMeta",
  "Footnote",
  "Divider",
  "Floating",
  "BackToTop",
  "Quote",
  "Equation",
  "Frac",
  "Pow",
  "Sqrt",
  "Sum",
  "Paren",
  "Button",
  "ReplyButton",
  "CopyButton",
  "LinkButton",
  "TextLink",
  "Input",
  "Toggle",
  "Checkbox",
  "Image",
  "Video",
  "Audio",
  "RatingSummary",
  "WatchCard",
  "Avatar",
  "CardGrid",
  "CardCarousel",
]);

const LONG = "w".repeat(5000);
const FIELD_VALUES: unknown[] = [
  undefined,
  null,
  0,
  -1,
  1e9,
  Number.NaN,
  Infinity,
  -Infinity,
  "",
  "x",
  LONG,
  true,
  false,
  [],
  [null],
  [Number.NaN],
  ["x"],
  [1, "2", null],
  [[1]],
];
const SHAPE_VALUES: unknown[] = [undefined, null, 0, Number.NaN, "x", LONG, true, {}, []];

// A small seeded generator, so a failure names a case that reruns identically.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(next: () => number, from: readonly T[]) => from[Math.floor(next() * from.length)];

function item(next: () => number, fields: readonly string[]): unknown {
  if (fields.length === 0) return pick(next, FIELD_VALUES);
  return Object.fromEntries(fields.map((field) => [field, pick(next, FIELD_VALUES)]));
}

function hostile(fields: readonly string[], seed: number): unknown[] {
  const next = random(seed);
  const generated = Array.from({ length: 40 }, () =>
    Array.from({ length: 1 + Math.floor(next() * 4) }, () => item(next, fields)),
  );
  const halfFilled = fields.map((field) => [{ [field]: "x" }]);
  // A plain object where a list holds text is React's own "not a valid child" error, as it is
  // anywhere else a page puts one; only lists of items are expected to skip it.
  const objects = fields.length ? [[{}], [undefined, {}]] : [];
  return [...SHAPE_VALUES, [null], [1], ["x"], ...objects, ...halfFilled, ...generated];
}

const base = (name: PageKitComponentName) => (name === "Page" ? { title: "Hostile" } : {});

describe("kit components with hostile list data", () => {
  it("names every component as either shaped or plain", () => {
    const unnamed = PAGE_KIT_COMPONENTS.filter((name) => !(name in SHAPED) && !PLAIN.has(name));
    expect(unnamed).toEqual([]);
  });

  it("render, rather than throw, whatever a list or object prop holds", () => {
    const failures: string[] = [];
    for (const [name, shaped] of Object.entries(SHAPED) as [PageKitComponentName, object][]) {
      const Component = kit[name] as ComponentType<Record<string, unknown>>;
      for (const [prop, fields] of Object.entries(shaped) as [string, string[]][]) {
        for (const [index, value] of hostile(fields, name.length * 997 + prop.length).entries()) {
          try {
            renderToStaticMarkup(createElement(Component, { ...base(name), [prop]: value }));
          } catch (error) {
            failures.push(`${name}.${prop} #${index}: ${(error as Error).message.split("\n")[0]}`);
            break;
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
