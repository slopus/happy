import type { ComponentType } from "react";
import type { PageHelperName, PageKitComponentName } from "../components.js";
import { PAGE_HELPERS, PAGE_KIT_COMPONENTS } from "../components.js";
import * as calendar from "./calendar.js";
import * as charts from "./charts.js";
import * as controls from "./controls.js";
import * as data from "./data.js";
import * as dataviz from "./dataviz.js";
import * as diagram from "./diagram.js";
import * as layout from "./layout.js";
import * as media from "./media.js";
import * as text from "./text.js";
import * as theme from "./theme.js";

const modules = {
  ...calendar,
  ...charts,
  ...controls,
  ...data,
  ...dataviz,
  ...diagram,
  ...layout,
  ...media,
  ...text,
  ...theme,
};

// Picked by the shared name lists, so the validator and the runtime offer the same names.
export const kit = Object.fromEntries(
  PAGE_KIT_COMPONENTS.map((name) => [name, modules[name]]),
) as unknown as Record<PageKitComponentName, ComponentType<never>>;

export const helpers = Object.fromEntries(
  PAGE_HELPERS.map((name) => [name, modules[name]]),
) as Record<PageHelperName, unknown>;

// Blocks a Section caption sits under; without one it sits under the first block.
for (const name of [
  "Table",
  "Metrics",
  "LineChart",
  "Bars",
  "Pie",
  "Diagram",
  "Grid",
  "ProsCons",
  "Columns",
  "ColumnSeries",
  "StackedBars",
  "Scatter",
  "Heatmap",
  "CalendarHeatmap",
  "Venn",
  "Matrix2x2",
] as const) {
  layout.FIGURES.add(kit[name]);
}
