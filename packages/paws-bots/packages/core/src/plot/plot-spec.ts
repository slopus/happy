/// <reference lib="dom" />
import * as Plot from "@observablehq/plot";
import { MAX_CHART_DATA_ROWS } from "@rakazo/contracts";
import { autoType, csvParseRows, tsvParseRows } from "d3-dsv";

/**
 * Declarative, JSON-only surface over Observable Plot for the render_plot
 * agent tool. Marks and transforms are allowlisted by name; specs carry plain
 * data and options, never code, so rendering stays safe server-side.
 */

export type PlotMarkSpec = {
  type: string;
  /** Per-mark data override; falls back to the spec-level data. */
  data?: unknown[];
  /** Mark channel options: x, y, stroke, fill, fx, fy, sort, tip, … */
  options?: Record<string, unknown>;
  /** Optional transform wrapping the options, e.g. {name:"binX", outputs:{y:"count"}}. */
  transform?: { name: string; outputs?: Record<string, unknown> };
};

export type PlotSpec = {
  title?: string;
  /** Rows may also arrive nested in the spec; treated like top-level data. */
  data?: unknown[];
  width?: number;
  height?: number;
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
  grid?: boolean;
  inset?: number;
  x?: Record<string, unknown>;
  y?: Record<string, unknown>;
  fx?: Record<string, unknown>;
  fy?: Record<string, unknown>;
  facet?: Record<string, unknown>;
  color?: Record<string, unknown>;
  r?: Record<string, unknown>;
  opacity?: Record<string, unknown>;
  symbol?: Record<string, unknown>;
  length?: Record<string, unknown>;
  projection?: unknown;
  marks: PlotMarkSpec[];
};

type MarkFactory = (data: unknown, options: Record<string, unknown>) => Plot.Markish;

const DATA_MARKS = {
  area: Plot.area,
  areaX: Plot.areaX,
  areaY: Plot.areaY,
  arrow: Plot.arrow,
  barX: Plot.barX,
  barY: Plot.barY,
  boxX: Plot.boxX,
  boxY: Plot.boxY,
  cell: Plot.cell,
  cellX: Plot.cellX,
  cellY: Plot.cellY,
  circle: Plot.circle,
  cluster: Plot.cluster,
  contour: Plot.contour as unknown as MarkFactory,
  delaunayLink: Plot.delaunayLink,
  delaunayMesh: Plot.delaunayMesh,
  density: Plot.density,
  dot: Plot.dot,
  dotX: Plot.dotX,
  dotY: Plot.dotY,
  hull: Plot.hull,
  line: Plot.line,
  lineX: Plot.lineX,
  lineY: Plot.lineY,
  linearRegressionX: Plot.linearRegressionX,
  linearRegressionY: Plot.linearRegressionY,
  link: Plot.link,
  raster: Plot.raster as unknown as MarkFactory,
  rect: Plot.rect,
  rectX: Plot.rectX,
  rectY: Plot.rectY,
  ruleX: Plot.ruleX,
  ruleY: Plot.ruleY,
  spike: Plot.spike,
  text: Plot.text,
  textX: Plot.textX,
  textY: Plot.textY,
  tickX: Plot.tickX,
  tickY: Plot.tickY,
  tree: Plot.tree,
  vector: Plot.vector,
  vectorX: Plot.vectorX,
  vectorY: Plot.vectorY,
  voronoi: Plot.voronoi,
  voronoiMesh: Plot.voronoiMesh,
  waffleX: Plot.waffleX,
  waffleY: Plot.waffleY,
} as unknown as Record<string, MarkFactory>;

const DATALESS_MARKS = {
  axisX: Plot.axisX,
  axisY: Plot.axisY,
  frame: Plot.frame,
  gridX: Plot.gridX,
  gridY: Plot.gridY,
  hexgrid: Plot.hexgrid,
  sphere: Plot.sphere,
  graticule: Plot.graticule,
} as unknown as Record<string, (options: Record<string, unknown>) => Plot.Markish>;

const MAX_PLOT_SIZE = 2_000;
const MAX_PLOT_TICKS = 1_000;
const MAX_PLOT_STEPS = 10_000;
// Contours redraw the whole grid once per threshold.
const MAX_CONTOUR_THRESHOLDS = 200;
const SIZE_OPTIONS = new Set([
  "width",
  "height",
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "inset",
  "insetTop",
  "insetRight",
  "insetBottom",
  "insetLeft",
]);
const MINIMUM_OPTIONS: Record<string, number> = {
  tickSpacing: 5,
  binWidth: 5,
  pixelSize: 1,
  precision: 0.01,
};
// Freedman-Diaconis is left out: a tight cluster plus one outlier yields unbounded bins.
const NAMED_THRESHOLDS = new Set(["auto", "scott", "sturges"]);

type PlotInterval = {
  floor(value: unknown): unknown;
  offset(value: unknown, step?: number): unknown;
  range(lo: unknown, hi: unknown): unknown[];
};

/** Number-like option value; undefined for anything Plot reads another way. */
function numericOption(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const number = Number(value);
  return Number.isNaN(number) ? undefined : number;
}

function tooMany(key: string, limit: number): Error {
  return new Error(
    `Plot ${key} would generate more than ${limit.toLocaleString("en-US")} values; use a coarser value.`,
  );
}

/** Plot's own interval for this value, refusing to enumerate more than maxSteps values. */
function boundedInterval(key: string, value: number | string, maxSteps: number, time: boolean) {
  const interval = (typeof value === "number"
    ? Plot.numberInterval(value)
    : (time ? Plot.timeInterval : Plot.utcInterval)(
        value as Plot.LiteralTimeInterval,
      )) as unknown as PlotInterval;
  return Object.assign(Object.create(interval) as PlotInterval, {
    range(lo: unknown, hi: unknown) {
      if (Number(interval.offset(interval.floor(lo), maxSteps)) < Number(hi)) {
        throw tooMany(key, maxSteps);
      }
      return interval.range(lo, hi);
    },
  });
}

function boundPlotOption(
  key: string,
  value: unknown,
  mark: string | undefined,
  time: boolean,
): unknown {
  if (key === "aspectRatio" && value != null) {
    // Plot derives the height from the data's extents, so no limit holds.
    throw new Error("Plot aspectRatio is not supported; set height instead.");
  }
  const maxSteps =
    key === "ticks"
      ? MAX_PLOT_TICKS
      : key !== "thresholds" && key !== "interval"
        ? undefined
        : mark === "contour" || mark === "density"
          ? MAX_CONTOUR_THRESHOLDS
          : MAX_PLOT_STEPS;
  if (Array.isArray(value)) {
    if (maxSteps !== undefined && value.length > maxSteps) throw tooMany(key, maxSteps);
    if (
      key === "range" &&
      value.some((item) => !(Math.abs(numericOption(item) ?? 0) <= MAX_PLOT_SIZE))
    ) {
      throw new Error(
        `Plot range must be within ±${MAX_PLOT_SIZE.toLocaleString("en-US")} pixels.`,
      );
    }
    return value;
  }
  if (value && typeof value === "object") return boundPlotOptions(value, mark);
  const number = numericOption(value);
  if (number !== undefined && SIZE_OPTIONS.has(key) && !(Math.abs(number) <= MAX_PLOT_SIZE)) {
    throw new Error(`Plot ${key} must be within ±${MAX_PLOT_SIZE.toLocaleString("en-US")} pixels.`);
  }
  const minimum = MINIMUM_OPTIONS[key];
  if (number !== undefined && minimum !== undefined && !(number >= minimum)) {
    throw new Error(`Plot ${key} must be at least ${minimum}.`);
  }
  if (maxSteps === undefined) return value;
  // A number is a count for ticks and thresholds but a step for interval.
  if (typeof value === "number" && key !== "interval") {
    if (value > maxSteps) throw tooMany(key, maxSteps);
    return value;
  }
  if (typeof value === "string" && value.toLowerCase() === "freedman-diaconis") {
    throw new Error(
      'Plot thresholds "freedman-diaconis" is not supported; use "scott" or a count.',
    );
  }
  if (
    typeof value === "number" ||
    (typeof value === "string" && !NAMED_THRESHOLDS.has(value.toLowerCase()))
  ) {
    // Plot reads string thresholds as UTC and other intervals in their scale's time zone.
    return boundedInterval(key, value, maxSteps, time && key !== "thresholds");
  }
  return value;
}

function boundPlotOptions(
  options: object,
  mark: string | undefined,
  time = false,
): Record<string, unknown> {
  const local = time || (options as { type?: unknown }).type === "time";
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, boundPlotOption(key, value, mark, local)]),
  );
}

/**
 * Ticks, bins, hexagons, contours and pixels grow with these options rather
 * than with the row count, so one small spec could stall the renderer.
 */
function boundPlotSpec(spec: PlotSpec): PlotSpec {
  const { data, marks, ...options } = spec;
  return {
    ...(boundPlotOptions(options, undefined) as Omit<PlotSpec, "data" | "marks">),
    ...(data === undefined ? {} : { data }),
    marks: marks.map((mark) => {
      const axis = /^(?:axis|grid)([XY])$/.exec(mark.type)?.[1]?.toLowerCase() as
        | "x"
        | "y"
        | undefined;
      const time = axis !== undefined && spec[axis]?.type === "time";
      const outputs = mark.transform?.outputs;
      return {
        ...mark,
        ...(mark.options ? { options: boundPlotOptions(mark.options, mark.type, time) } : {}),
        ...(mark.transform && outputs && typeof outputs === "object"
          ? { transform: { ...mark.transform, outputs: boundPlotOptions(outputs, mark.type) } }
          : {}),
      };
    }),
  };
}

type TransformFactory = (
  outputs: Record<string, unknown>,
  options: Record<string, unknown>,
) => Record<string, unknown>;

const TRANSFORMS = {
  bin: Plot.bin,
  binX: Plot.binX,
  binY: Plot.binY,
  group: Plot.group,
  groupX: Plot.groupX,
  groupY: Plot.groupY,
  groupZ: Plot.groupZ,
  hexbin: Plot.hexbin,
  normalizeX: Plot.normalizeX,
  normalizeY: Plot.normalizeY,
  windowX: Plot.windowX,
  windowY: Plot.windowY,
  stackX: Plot.stackX,
  stackY: Plot.stackY,
  dodgeX: Plot.dodgeX,
  dodgeY: Plot.dodgeY,
  shiftX: Plot.shiftX,
  select: Plot.select,
} as unknown as Record<string, TransformFactory>;

export function supportedPlotNames(): { marks: string[]; transforms: string[] } {
  return {
    marks: [...Object.keys(DATA_MARKS), ...Object.keys(DATALESS_MARKS)].sort(),
    transforms: Object.keys(TRANSFORMS).sort(),
  };
}

/** Bound all row arrays carried by a plot, including per-mark overrides. */
export function assertPlotDataWithinLimits(spec: PlotSpec, data: unknown[] | undefined): void {
  const marks = Array.isArray(spec.marks) ? spec.marks : [];
  const sources = [data, spec.data, ...marks.map((mark) => mark.data)].filter(
    (rows): rows is unknown[] => Array.isArray(rows),
  );
  const rowCount = sources.reduce((total, rows) => total + rows.length, 0);
  if (rowCount > MAX_CHART_DATA_ROWS) {
    throw new Error(
      `Plot data exceeds the ${MAX_CHART_DATA_ROWS.toLocaleString("en-US")}-row limit across top-level, spec, and mark data.`,
    );
  }
}

// Channels where a string must name a column; a typo otherwise renders an
// empty chart with no error, which strands the calling model.
const COLUMN_CHANNELS = ["x", "y", "x1", "x2", "y1", "y2", "fx", "fy"] as const;

function assertChannelsMatchColumns(mark: PlotMarkSpec, data: unknown[]): void {
  const first = data[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return;
  const keys = Object.keys(first);
  const available = new Set(keys);
  let namedChannels = 0;
  for (const channel of COLUMN_CHANNELS) {
    const value = mark.options?.[channel];
    if (value !== undefined) namedChannels += 1;
    if (typeof value === "string" && !available.has(value)) {
      throw new Error(
        `Mark "${mark.type}": ${channel} refers to "${value}" but the data columns are: ${keys.join(", ")}. Channel names must match data keys exactly.`,
      );
    }
  }
  if (namedChannels === 0 && !mark.transform) {
    throw new Error(
      `Mark "${mark.type}" has object rows but no position channels; set options like {"x": "<column>", "y": "<column>"} using these columns: ${keys.join(", ")}.`,
    );
  }
}

/** Models also hand over data as CSV text lines; parse those into rows. */
function normalizeRows(rows: unknown[]): unknown[] {
  if (
    rows.length > 1 &&
    rows.every((row) => typeof row === "string") &&
    (rows[0] as string).includes(",")
  ) {
    return parsePlotData("data.csv", rows.join("\n"));
  }
  return coerceNumericStrings(rows);
}

/** Models often send numbers as JSON strings; ordinal-typed values then stack
    into one giant bar instead of measuring. Coerce numeric-looking strings. */
function coerceNumericStrings(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = typeof value === "string" && isPlainNumber(value) ? Number(value) : value;
    }
    return out;
  });
}

function isPlainNumber(value: string): boolean {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  return trimmed !== "" && Number.isFinite(parsed) && String(parsed) === trimmed;
}

function buildMark(
  mark: PlotMarkSpec,
  sharedData: unknown[] | undefined,
  normalizeData: (rows: unknown[]) => unknown[],
): Plot.Markish {
  // A class name could match the app's own styles once the chart is in its page.
  const { className: _className, ...options } = mark.options ?? {};
  const dataless = DATALESS_MARKS[mark.type];
  if (dataless) return dataless(options);
  const factory = DATA_MARKS[mark.type];
  if (!factory) {
    throw new Error(
      `Unsupported mark type "${mark.type}". Supported marks: ${supportedPlotNames().marks.join(", ")}`,
    );
  }
  const rawData = mark.data ?? sharedData;
  if (!rawData) throw new Error(`Mark "${mark.type}" has no data and the spec has no shared data.`);
  if (Array.isArray(rawData) && rawData.length === 0) {
    throw new Error(`Mark "${mark.type}" received an empty data array; pass the rows in "data".`);
  }
  const data = normalizeData(rawData);
  assertChannelsMatchColumns(mark, data);
  let finalOptions: Record<string, unknown> = options;
  if (mark.transform) {
    const transform = TRANSFORMS[mark.transform.name];
    if (!transform) {
      throw new Error(
        `Unsupported transform "${mark.transform.name}". Supported transforms: ${supportedPlotNames().transforms.join(", ")}`,
      );
    }
    const outputs = mark.transform.outputs ?? {};
    // normalize* takes a bare basis value ("sum", "extent", …), not an outputs object.
    const first = mark.transform.name.startsWith("normalize")
      ? ((outputs as { basis?: unknown }).basis ?? "sum")
      : outputs;
    finalOptions = transform(first as Record<string, unknown>, options);
  }
  return factory(data, finalOptions);
}

/** csvParse builds row objects with `new Function`, which the web app's CSP blocks. */
function delimitedRows([columns = [], ...rows]: string[][]): unknown[] {
  return rows.map((row) =>
    autoType(Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""]))),
  );
}

export function parsePlotData(name: string, content: string): unknown[] {
  if (/\.csv$/i.test(name)) return delimitedRows(csvParseRows(content));
  if (/\.tsv$/i.test(name)) return delimitedRows(tsvParseRows(content));
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("JSON data files must contain a top-level array of rows");
  return parsed;
}

const XMLNS = "http://www.w3.org/2000/xmlns/";

function isSafePlotLink(href: string): boolean {
  try {
    // Use the URL parser's control-character and scheme handling. The fixed
    // base allows relative links even in the server's about:blank document;
    // retain the original attribute so clients resolve it against their page.
    const { protocol } = new URL(href, "https://plot.invalid/");
    return ["http:", "https:", "mailto:", "tel:"].includes(protocol);
  } catch {
    return false;
  }
}

// A backslash could spell url() as a CSS escape.
const REMOTE_CSS_URL = /\\|url\(\s*(?!['"]?#)/i;

function sanitizePlot(plotted: Element): void {
  // Inspect the resolved output: href can come from columns, per-mark arrays,
  // channel objects, scales, or transforms. Check both href and xlink:href
  // before either mounting the live plot or serializing it for export. Colors
  // and filters may be url() references; only the chart's own #ids may load.
  for (const element of [plotted, ...Array.from(plotted.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      const unsafeLink =
        element.localName === "a" &&
        (attribute.localName === "target" ||
          (attribute.localName === "href" && !isSafePlotLink(attribute.value)));
      if (unsafeLink || REMOTE_CSS_URL.test(attribute.value)) {
        element.removeAttributeNode(attribute);
      }
    }
  }
}

export type PlotParts = {
  /** The rendered element (an <svg>, or a <figure> wrapping one). */
  plotted: Element;
  /** The plot's own <svg>, for serialization. */
  svg: Element;
  title?: string;
  swatches: { label: string; color: string }[];
  width: number;
  height: number;
};

/**
 * Build the rendered plot element plus title and categorical legend metadata.
 * Shared by the server (which composes a standalone SVG for PNG export) and
 * the browser (which mounts the element live and draws title/legend as HTML).
 */
export function buildPlotParts(
  spec: PlotSpec,
  data: unknown[] | undefined,
  document: Document,
  overrides: { width?: number; height?: number } = {},
): PlotParts {
  if (!Array.isArray(spec.marks) || spec.marks.length === 0) {
    throw new Error("The spec needs a non-empty marks array.");
  }
  assertPlotDataWithinLimits(spec, data);
  // Plot applies style and className to the live page, outside the chart.
  const {
    title,
    marks,
    data: nestedData,
    style: _style,
    className: _className,
    ...plotOptions
  } = boundPlotSpec(spec) as PlotSpec & { style?: unknown; className?: unknown };
  const sharedData = data ?? (Array.isArray(nestedData) ? nestedData : undefined);
  const normalizedData = new WeakMap<unknown[], unknown[]>();
  const normalizeData = (rows: unknown[]) => {
    const cached = normalizedData.get(rows);
    if (cached) return cached;
    const normalized = normalizeRows(rows);
    normalizedData.set(rows, normalized);
    return normalized;
  };
  const sanitizedPlotOptions = { ...plotOptions } as Record<string, unknown>;
  for (const scale of ["color", "x", "y", "fx", "fy", "r", "opacity", "symbol"] as const) {
    const options = sanitizedPlotOptions[scale];
    // Plot renders legends/titles as HTML <figure> wrappers, which cannot
    // rasterize to a standalone image; title and swatches are composed by the
    // caller instead.
    if (options && typeof options === "object") {
      const scaleOptions = { ...(options as Record<string, unknown>) };
      delete scaleOptions.legend;
      sanitizedPlotOptions[scale] = scaleOptions;
    }
  }
  const plotted = Plot.plot({
    ...(sanitizedPlotOptions as Plot.PlotOptions),
    document,
    ...(overrides.width ? { width: overrides.width } : {}),
    ...(overrides.height ? { height: overrides.height } : {}),
    marks: marks.map((mark) => buildMark(mark, sharedData, normalizeData)),
  });
  sanitizePlot(plotted);
  const svg = plotted.tagName === "svg" ? plotted : plotted.querySelector("svg");
  if (!svg) throw new Error("Plot did not produce an SVG element");
  const width = Number(svg.getAttribute("width") ?? overrides.width ?? spec.width ?? 640);
  const height = Number(svg.getAttribute("height") ?? overrides.height ?? spec.height ?? 400);
  const colorScale = (
    plotted as unknown as { scale?: (name: string) => Plot.Scale | undefined }
  ).scale?.("color");
  return { plotted, svg, title, swatches: categoricalSwatches(colorScale), width, height };
}

export function renderPlotSpecToSvg(
  spec: PlotSpec,
  data: unknown[] | undefined,
  document: Document,
): string {
  const { svg, title, swatches, width, height } = buildPlotParts(spec, data, document);
  const titleHeight = title ? 28 : 0;
  const header: string[] = [];
  if (title) {
    header.push(
      `<text x="8" y="19" font-family="system-ui, sans-serif" font-size="15" font-weight="600" fill="currentColor">${escapeXml(title)}</text>`,
    );
  }
  let swatchX = 8;
  let swatchY = 0;
  let rowHeight = 0;
  const labelWidth = Math.max(1, width - 8 - 8 - 15);
  for (const { label, color } of swatches) {
    const lines = wrapLegendLabel(label, labelWidth);
    const entryWidth = 15 + lines.reduce((max, line) => Math.max(max, line.width), 0);
    if (swatchX > 8 && swatchX + entryWidth > width - 8) {
      swatchX = 8;
      swatchY += rowHeight;
      rowHeight = 0;
    }
    rowHeight = Math.max(rowHeight, 24 + (lines.length - 1) * 16);
    const labelLines = lines
      .map(
        (line, index) =>
          `<tspan x="${swatchX + 15}" dy="${index === 0 ? 0 : 16}"${line.fontSize ? ` font-size="${line.fontSize}"` : ""}>${escapeXml(line.text)}</tspan>`,
      )
      .join("");
    header.push(
      `<rect x="${swatchX}" y="${titleHeight + swatchY + 5}" width="11" height="11" fill="${escapeXml(color)}"></rect>`,
      `<text x="${swatchX + 15}" y="${titleHeight + swatchY + 15}" font-family="system-ui, sans-serif" font-size="12" fill="currentColor">${labelLines}</text>`,
    );
    swatchX += entryWidth + 22;
  }
  const legendHeight = swatchY + rowHeight;
  const totalHeight = height + titleHeight + legendHeight;
  svg.setAttributeNS(XMLNS, "xmlns", "http://www.w3.org/2000/svg");
  svg.setAttributeNS(XMLNS, "xmlns:xlink", "http://www.w3.org/1999/xlink");
  svg.setAttribute("y", String(titleHeight + legendHeight));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}" font-family="system-ui, sans-serif" style="background:#ffffff;color:#1a1a1a">${header.join("")}${svg.outerHTML}</svg>`;
}

function wrapLegendLabel(label: string, maxWidth: number) {
  const lines: { text: string; width: number }[] = [];
  let text = "";
  let width = 0;
  // Conservative 12px-font advances work without browser layout in the server
  // DOM. Emoji budgets count visible bases for fallback fonts, not code units,
  // joiners, variation selectors, or modifiers.
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    label,
  )) {
    const bases = Array.from(
      segment.replace(/\p{Mark}|\p{Emoji_Modifier}|\p{Default_Ignorable_Code_Point}/gu, ""),
    );
    const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment);
    const advance = emoji
      ? Math.max(28, bases.length * 14)
      : bases.reduce((sum, base) => {
          const ordinary = /^[a-z0-9]$/.test(base) && base !== "m" && base !== "w";
          const wide = "MWmw".includes(base) || base.codePointAt(0)! > 127;
          return sum + (base === " " ? 6 : ordinary ? 9 : wide ? 14 : 12);
        }, 0);
    if (text && width + advance > maxWidth) {
      lines.push({ text, width });
      text = "";
      width = 0;
    }
    text += segment;
    width += advance;
  }
  lines.push({ text, width });
  return lines.map((line) => ({
    text: line.text,
    width: Math.min(line.width, maxWidth),
    // Shrink an oversized grapheme; textLength could instead enlarge it when
    // its natural width is smaller than our conservative estimate.
    fontSize: line.width > maxWidth ? (12 * maxWidth) / line.width : undefined,
  }));
}

function categoricalSwatches(scale: Plot.Scale | undefined): { label: string; color: string }[] {
  if (!scale || typeof scale.apply !== "function") return [];
  const domain = Array.isArray(scale.domain) ? scale.domain : [];
  if (domain.length === 0 || domain.length > 12) return [];
  if (scale.type && scale.type !== "ordinal" && scale.type !== "categorical") return [];
  return domain
    .map((value) => ({ label: String(value), color: String(scale.apply(value)) }))
    .filter(({ color }) => !REMOTE_CSS_URL.test(color));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
