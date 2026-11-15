import type { PlotSpec } from "./plot-spec.js";

export type ChartCatalogEntry = {
  name: string;
  when: string;
  keywords: string;
  /** Complete runnable example: substitute your own rows and column names. */
  spec: PlotSpec;
};

const SALES = [
  { quarter: "Q1", region: "east", sales: 120 },
  { quarter: "Q2", region: "east", sales: 185 },
  { quarter: "Q3", region: "east", sales: 143 },
  { quarter: "Q4", region: "east", sales: 210 },
  { quarter: "Q1", region: "west", sales: 90 },
  { quarter: "Q2", region: "west", sales: 132 },
  { quarter: "Q3", region: "west", sales: 166 },
  { quarter: "Q4", region: "west", sales: 158 },
];

const MEASURES = [
  { size: 4.2, weight: 31, kind: "a" },
  { size: 5.1, weight: 42, kind: "a" },
  { size: 6.3, weight: 51, kind: "b" },
  { size: 4.8, weight: 36, kind: "b" },
  { size: 5.9, weight: 48, kind: "a" },
  { size: 6.8, weight: 57, kind: "b" },
  { size: 5.4, weight: 44, kind: "a" },
  { size: 4.5, weight: 33, kind: "b" },
];

export const CHART_CATALOG: ChartCatalogEntry[] = [
  {
    name: "bar",
    when: "Compare one value across categories",
    keywords: "bar column comparison rank vendor category",
    spec: {
      title: "Sales by quarter",
      data: SALES.slice(0, 4),
      marks: [{ type: "barY", options: { x: "quarter", y: "sales" } }],
    },
  },
  {
    name: "horizontal bar",
    when: "Compare categories with long names, sorted by value",
    keywords: "bar horizontal rank sorted top",
    spec: {
      title: "Sales by quarter",
      data: SALES.slice(0, 4),
      marginLeft: 60,
      marks: [{ type: "barX", options: { y: "quarter", x: "sales", sort: { y: "-x" } } }],
    },
  },
  {
    name: "stacked bar",
    when: "Category totals split by a sub-category",
    keywords: "stacked composition part-of-whole share breakdown",
    spec: {
      title: "Sales by quarter and region",
      data: SALES,
      marks: [{ type: "barY", options: { x: "quarter", y: "sales", fill: "region" } }],
    },
  },
  {
    name: "grouped bar",
    when: "Compare sub-categories side by side within groups",
    keywords: "grouped side-by-side clustered",
    spec: {
      title: "Sales by region per quarter",
      data: SALES,
      marks: [
        { type: "barY", options: { fx: "quarter", x: "region", y: "sales", fill: "region" } },
      ],
    },
  },
  {
    name: "normalized bar",
    when: "Compare percentage shares across categories",
    keywords: "percent share normalized 100%",
    spec: {
      title: "Regional share per quarter",
      data: SALES,
      y: { percent: true },
      marks: [
        {
          type: "barY",
          transform: { name: "normalizeY", outputs: { basis: "sum" } },
          options: { x: "quarter", y: "sales", fill: "region" },
        },
      ],
    },
  },
  {
    name: "histogram",
    when: "Distribution of one numeric column",
    keywords: "histogram distribution frequency bins spread",
    spec: {
      title: "Weight distribution",
      data: MEASURES,
      marks: [
        {
          type: "rectY",
          transform: { name: "binX", outputs: { y: "count" } },
          options: { x: "weight" },
        },
        { type: "ruleY", data: [0] },
      ],
    },
  },
  {
    name: "scatter",
    when: "Relationship between two numeric columns",
    keywords: "scatter correlation relationship points xy",
    spec: {
      title: "Weight vs size",
      data: MEASURES,
      grid: true,
      marks: [{ type: "dot", options: { x: "size", y: "weight", stroke: "kind" } }],
    },
  },
  {
    name: "scatter with trend",
    when: "Relationship plus a linear trend line",
    keywords: "regression trend fit correlation",
    spec: {
      title: "Weight vs size with trend",
      data: MEASURES,
      marks: [
        { type: "dot", options: { x: "size", y: "weight" } },
        { type: "linearRegressionY", options: { x: "size", y: "weight", stroke: "red" } },
      ],
    },
  },
  {
    name: "bubble",
    when: "Scatter with a third value shown as dot size",
    keywords: "bubble size magnitude three variables",
    spec: {
      title: "Sized by weight",
      data: MEASURES,
      marks: [
        {
          type: "dot",
          options: { x: "size", y: "weight", r: "weight", fill: "kind", fillOpacity: 0.6 },
        },
      ],
    },
  },
  {
    name: "line",
    when: "A value changing over an ordered axis (time)",
    keywords: "line time series trend over-time",
    spec: {
      title: "Sales over quarters",
      data: SALES.slice(0, 4),
      marks: [
        { type: "lineY", options: { x: "quarter", y: "sales" } },
        { type: "dot", options: { x: "quarter", y: "sales" } },
      ],
    },
  },
  {
    name: "multi line",
    when: "One line per category over time",
    keywords: "multi-series lines compare trends",
    spec: {
      title: "Sales by region",
      data: SALES,
      marks: [{ type: "lineY", options: { x: "quarter", y: "sales", stroke: "region" } }],
    },
  },
  {
    name: "area",
    when: "Magnitude over time with filled area",
    keywords: "area filled volume cumulative",
    spec: {
      title: "Sales area",
      data: SALES.slice(0, 4),
      marks: [
        { type: "areaY", options: { x: "quarter", y: "sales", fillOpacity: 0.4 } },
        { type: "lineY", options: { x: "quarter", y: "sales" } },
      ],
    },
  },
  {
    name: "stacked area",
    when: "Composition over time",
    keywords: "stacked area composition over-time streamgraph",
    spec: {
      title: "Sales composition",
      data: SALES,
      marks: [{ type: "areaY", options: { x: "quarter", y: "sales", fill: "region" } }],
    },
  },
  {
    name: "heatmap",
    when: "A value across two categorical axes",
    keywords: "heatmap matrix grid cells intensity",
    spec: {
      title: "Sales heat",
      data: SALES,
      marks: [{ type: "cell", options: { x: "quarter", y: "region", fill: "sales" } }],
    },
  },
  {
    name: "box plot",
    when: "Distribution summary per category",
    keywords: "box whisker quartile median outliers",
    spec: {
      title: "Weight by kind",
      data: MEASURES,
      marks: [{ type: "boxY", options: { x: "kind", y: "weight" } }],
    },
  },
  {
    name: "strip plot",
    when: "Raw value ticks per category",
    keywords: "strip ticks raw values jitter",
    spec: {
      title: "Weights by kind",
      data: MEASURES,
      marks: [{ type: "tickX", options: { x: "weight", y: "kind" } }],
    },
  },
  {
    name: "waffle",
    when: "Part-of-whole as counted squares (pie-chart alternative)",
    keywords: "waffle pie donut share proportion",
    spec: {
      title: "Sales share",
      data: SALES.slice(0, 4),
      marks: [{ type: "waffleY", options: { x: "quarter", y: "sales", fill: "quarter" } }],
    },
  },
  {
    name: "small multiples",
    when: "Same chart repeated per category",
    keywords: "facets small-multiples panels grid per-category",
    spec: {
      title: "Per-region panels",
      data: SALES,
      marks: [{ type: "barY", options: { x: "quarter", y: "sales", fx: "region" } }],
    },
  },
  {
    name: "moving average",
    when: "Smooth a noisy series",
    keywords: "rolling moving average smooth window",
    spec: {
      title: "Smoothed sales",
      data: SALES,
      marks: [
        { type: "lineY", options: { x: "quarter", y: "sales", stroke: "#bbb" } },
        {
          type: "lineY",
          transform: { name: "windowY", outputs: { k: 3, reduce: "mean" } },
          options: { x: "quarter", y: "sales" },
        },
      ],
    },
  },
  {
    name: "annotated",
    when: "Any chart plus reference lines and labels",
    keywords: "annotation reference threshold target label",
    spec: {
      title: "Sales vs target",
      data: SALES.slice(0, 4),
      marks: [
        { type: "barY", options: { x: "quarter", y: "sales" } },
        { type: "ruleY", data: [150], options: { stroke: "red" } },
        {
          type: "text",
          data: [{ quarter: "Q1", sales: 160 }],
          options: { x: "quarter", y: "sales", text: ["target 150"], fill: "red" },
        },
      ],
    },
  },
];

export function searchChartCatalog(query?: string): ChartCatalogEntry[] {
  if (!query || typeof query !== "string") return CHART_CATALOG;
  const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = CHART_CATALOG.filter((entry) => {
    const haystack = `${entry.name} ${entry.when} ${entry.keywords}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
  return matches.length > 0 ? matches : CHART_CATALOG;
}

export const PLOT_TOOL_GUIDE = `# render_plot — deep data visualization skill

You can produce publication-quality charts with the render_plot tool, backed by
Observable Plot (the grammar behind the Observable Plot gallery). You describe
the chart as a JSON spec; the tool renders it to a PNG in your workspace and
attaches it to the chat.

## How to use the tool

1. Get or shape the data: an array of row objects. Either pass it inline as
   "data", or write it to a .csv/.tsv/.json file in your home and pass
   "data_path". CSV/TSV columns are auto-typed (numbers and dates are parsed).
2. Choose the chart form for the question. Call render_plot with
   {"charts": true} to list every chart type with a complete runnable example
   spec, or {"charts": "distribution"} to search by keyword. Copy the closest
   example and substitute your rows and column names.
3. Call render_plot with {"spec": {...}, "data": [...]} or
   {"spec": {...}, "data_path": "sales.csv"}.
4. The tool attaches the PNG to the chat automatically (attach: false to skip)
   and returns the output path, for example charts/plot-1.png.
5. Iterate: adjust marks, scales, and facets until the chart answers the
   question. Prefer several small focused charts over one crowded chart.

## Spec format

{
  "title": "optional chart title",
  "width": 640, "height": 400,
  "grid": true,
  "x": {"label": "…", "type": "log|linear|utc|band|point", "domain": […]},
  "y": {…}, "color": {"scheme": "tableau10|blues|turbo|…", "type": "diverging"},
  "fx": {…}, "fy": {…},                    // facet scales
  "marks": [
    {"type": "dot", "options": {"x": "field", "y": "field", "stroke": "category", "tip": true}},
    {"type": "ruleY", "data": [0]}         // per-mark data for annotations
  ]
}

Channel values are column names ("x": "price"), constants ("fill": "#4269d0"),
or for faceting put "fx"/"fy" in a mark's options. Add "sort": {"x": "-y"} to
order categories by value. Transforms wrap a mark's options:

  {"type": "rectY", "transform": {"name": "binX", "outputs": {"y": "count"}},
   "options": {"x": "weight", "fill": "species"}}

## Chart catalog (from the Plot gallery)

- Bar chart: barY + {"x": category, "y": value}; horizontal: barX with y category.
- Grouped / stacked bars: add "fill": category (stacks automatically);
  grouped: use "fx": category with barY.
- Histogram: rectY + transform binX with outputs {"y": "count"}.
- 2D histogram / heatmap: rect + transform bin with outputs {"fill": "count"};
  categorical heatmap: cell + {"x", "y", "fill": value}.
- Hex density: dot with transform hexbin, outputs {"r": "count"} or {"fill": "count"}.
- Scatterplot: dot + {"x", "y"}; bubble: add "r": value; add
  linearRegressionY for a trend line.
- Line chart: lineY + {"x": time, "y": value}; multi-series: add "stroke": category.
- Moving average: lineY + transform windowY; the window settings go in the
  transform outputs, e.g. {"name": "windowY", "outputs": {"k": 7, "reduce": "mean"}}.
- Area / streamgraph: areaY + {"x", "y", "fill": category} (+ "offset": "wiggle"
  in the y scale for streamgraphs).
- Box plot: boxY + {"x": category, "y": value}.
- Distribution ticks / strip plot: tickX + {"x": value, "y": category}.
- Slope / bump styles: line + point marks combined.
- Normalized shares: barY with transform normalizeY, or y scale {"percent": true}.
- Small multiples: any mark + "fx"/"fy" in its options (one panel per category).
- Candlestick-style ranges: ruleX with {"x", "y1", "y2"}.
- Tree / hierarchy: tree mark with path data like ["a/b/c", …].
- Network / flows: arrow or link marks with {"x1","y1","x2","y2"}.
- Contours / density: density for 2D point density, contour for gridded values.
- Waffle chart: waffleY + {"y": value, "fill": category}.
- Annotations: text marks for labels, ruleX/ruleY with per-mark "data" for
  reference lines, frame for panel borders.
- Maps: projection option (e.g. "equal-earth") with geo-ready coordinates on
  dot/spike/vector marks; sphere and graticule marks for context.

## Design rules

- Always label: set x/y {"label": …} when column names are cryptic; add a title.
- "tip": true on the primary mark documents exact values in the SVG structure.
- Use color only when it encodes something; categorical legends render
  automatically for up to 12 categories.
- Continuous color scales render without a legend bar — encode the scale
  meaning in the title or caption text instead.
- Sort categorical axes by value ("sort": {"x": "-y"}) unless order is inherent.
- Prefer binning/aggregation transforms over plotting tens of thousands of raw
  points; raw dots beyond ~5k rows get slow and unreadable.

Call render_plot with {"help": true} anytime to reread this guide.
`;
