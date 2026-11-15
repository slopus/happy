import { CHART_CATALOG, searchChartCatalog } from "@rakazo/core/plot-catalog";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { PlotSpec } from "./plot-tool.js";
import {
  buildPlotParts,
  parsePlotData,
  plotSvgToPng,
  renderPlotSpecToSvg,
  supportedPlotNames,
} from "./plot-tool.js";

const dom = () => new JSDOM("").window.document;

const penguinish = [
  { length: 39.1, depth: 18.7, species: "Adelie", island: "Torgersen" },
  { length: 46.5, depth: 17.9, species: "Chinstrap", island: "Dream" },
  { length: 50.0, depth: 15.2, species: "Gentoo", island: "Biscoe" },
  { length: 41.3, depth: 19.1, species: "Adelie", island: "Dream" },
  { length: 48.7, depth: 14.1, species: "Gentoo", island: "Biscoe" },
];

describe("render_plot", () => {
  it.each(["axisX", "axisY", "gridX", "gridY"])(
    "rejects excessive generated ticks in a %s mark without input rows",
    (type) => {
      expect(() =>
        renderPlotSpecToSvg(
          {
            x: { domain: [0, 1] },
            y: { domain: [0, 1] },
            marks: [{ type, options: { ticks: 10_000 } }],
          },
          undefined,
          dom(),
        ),
      ).toThrow("Plot ticks would generate more than 1,000 values");
    },
  );

  it.each(["x", "y", "fx", "fy"])("rejects excessive ticks in the %s scale", (scale) => {
    expect(() =>
      renderPlotSpecToSvg(
        { [scale]: { domain: [0, 1], ticks: 10_000 }, marks: [{ type: "frame" }] },
        undefined,
        dom(),
      ),
    ).toThrow("Plot ticks would generate more than 1,000 values");
  });

  describe("generated geometry limits", () => {
    const series = Array.from({ length: 100 }, (_, i) => ({
      a: i,
      b: i % 7,
      at: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000),
    }));
    const dot = { type: "dot", options: { x: "a", y: "b" } };
    const contour = (options: Record<string, unknown>) => ({
      marks: [{ type: "contour", options: { x: "a", y: "b", fill: "b", ...options } }],
    });

    it.each<[string, PlotSpec, RegExp]>([
      ["width", { width: 100_000, marks: [dot] }, /width must be within ±2,000/],
      ["height", { height: "100000" as never, marks: [dot] }, /height must be within ±2,000/],
      ["margin", { marginLeft: -100_000, marks: [dot] }, /marginLeft must be within ±2,000/],
      ["scale inset", { x: { inset: -100_000 }, marks: [dot] }, /inset must be within ±2,000/],
      ["scale range", { x: { range: [0, 100_000] }, marks: [dot] }, /range must be within ±2,000/],
      ["tick spacing", { x: { tickSpacing: 0.5 }, marks: [dot] }, /tickSpacing must be at least 5/],
      [
        "grid tick spacing",
        { marks: [{ type: "gridX", options: { tickSpacing: 0.5 } }, dot] },
        /tickSpacing must be at least 5/,
      ],
      [
        "hexgrid",
        { marks: [{ type: "hexgrid", options: { binWidth: 2 } }, dot] },
        /binWidth must be at least 5/,
      ],
      ["contour pixels", contour({ pixelSize: 0.5 }), /pixelSize must be at least 1/],
      [
        "contour thresholds",
        contour({ thresholds: 300 }),
        /thresholds would generate more than 200/,
      ],
      ["contour interval", contour({ interval: 0.02 }), /interval would generate more than 200/],
      [
        "projection precision",
        { projection: { type: "equal-earth", precision: 1e-5 }, marks: [{ type: "sphere" }] },
        /precision must be at least 0.01/,
      ],
      [
        "aspect ratio",
        { aspectRatio: 1, marks: [dot] } as PlotSpec,
        /aspectRatio is not supported; set height instead/,
      ],
      [
        "data-dependent bin count",
        {
          marks: [
            {
              type: "rectY",
              transform: { name: "binX", outputs: { y: "count", thresholds: "freedman-diaconis" } },
              options: { x: "a" },
            },
          ],
        },
        /"freedman-diaconis" is not supported/,
      ],
      [
        "contour thresholds list",
        contour({ thresholds: Array.from({ length: 201 }, (_, i) => i / 40) }),
        /thresholds would generate more than 200/,
      ],
      [
        "ticks list",
        { x: { ticks: Array.from({ length: 1_001 }, (_, i) => i / 10) }, marks: [dot] },
        /ticks would generate more than 1,000/,
      ],
      [
        "monthly ticks",
        {
          x: { ticks: "1 month" },
          marks: [
            {
              type: "dot",
              data: [
                { at: new Date(Date.UTC(2000, 0, 1)) },
                { at: new Date(Date.UTC(2083, 4, 2)) },
              ],
              options: { x: "at" },
            },
          ],
        },
        /ticks would generate more than 1,000/,
      ],
      [
        "tick interval",
        { x: { ticks: "1 hour" }, marks: [{ type: "dot", options: { x: "at", y: "b" } }] },
        /ticks would generate more than 1,000 values/,
      ],
      [
        "scale interval",
        { x: { interval: 0.005 }, marks: [{ type: "barY", options: { x: "a", y: "b" } }] },
        /interval would generate more than 10,000/,
      ],
      [
        "bin interval",
        {
          marks: [
            {
              type: "rectY",
              transform: { name: "binX", outputs: { y: "count" } },
              options: { x: "a", interval: 0.005 },
            },
          ],
        },
        /interval would generate more than 10,000/,
      ],
    ])("rejects an oversized %s before rendering", (_name, spec, message) => {
      expect(() => renderPlotSpecToSvg(spec, series, dom())).toThrow(message);
    });

    it("keeps ordinary interval, threshold and size options", () => {
      const svg = renderPlotSpecToSvg(
        {
          width: 1_200,
          height: 600,
          marginLeft: 60,
          x: { interval: 1, ticks: 20 },
          marks: [
            { type: "barY", options: { x: "a", y: "b" } },
            { type: "axisX", options: { ticks: "1 day", tickSpacing: 40 } },
          ],
        },
        series,
        dom(),
      );
      expect(svg).toContain('width="1200"');
      const daily = renderPlotSpecToSvg(
        {
          x: { type: "time", ticks: "1 week" },
          marks: [{ type: "dot", options: { x: "at", y: "b" } }],
        },
        series,
        dom(),
      );
      expect(daily).toContain("<svg");
      const histogram = buildPlotParts(
        contour({ thresholds: 20, pixelSize: 2 }),
        series,
        dom(),
      ).plotted;
      expect(histogram.querySelectorAll("path").length).toBeGreaterThan(0);
    });
  });

  it("renders a bounded custom tick count", () => {
    const { plotted } = buildPlotParts(
      { x: { domain: [0, 10] }, marks: [{ type: "axisX", options: { ticks: 10 } }] },
      undefined,
      dom(),
    );
    expect(plotted.querySelectorAll("text")).toHaveLength(11);
  });

  it("renders a titled scatterplot with a categorical legend into standalone SVG", () => {
    const svg = renderPlotSpecToSvg(
      {
        title: "Culmen shape by species",
        marks: [{ type: "dot", options: { x: "length", y: "depth", stroke: "species" } }],
      },
      penguinish,
      dom(),
    );
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg).toContain("Culmen shape by species");
    for (const species of ["Adelie", "Chinstrap", "Gentoo"]) expect(svg).toContain(species);
    expect(svg).toContain("circle");
  });

  it("does not mutate caller-owned scale options", () => {
    const color = Object.freeze({ legend: true });
    const spec: PlotSpec = {
      color,
      marks: [{ type: "dot", options: { x: "length", y: "depth", stroke: "species" } }],
    };

    expect(() => renderPlotSpecToSvg(spec, penguinish, dom())).not.toThrow();
    expect(color.legend).toBe(true);
  });

  function exportedCategories(labels: string[], width = 640, title?: string) {
    const spec: PlotSpec = {
      width,
      height: 200,
      title,
      marks: [{ type: "dot", options: { x: "x", y: "y", fill: "category" } }],
    };
    const data = labels.map((category, x) => ({ category, x, y: x + 1 }));
    const svg = renderPlotSpecToSvg(spec, data, dom());
    return new JSDOM(svg, { contentType: "image/svg+xml" }).window.document.documentElement;
  }

  it.each([undefined, "Categories"])("wraps ten exported legend entries with title %j", (title) => {
    const labels = Array.from({ length: 10 }, (_, i) => `Category ${i + 1}`);
    const svg = exportedCategories(labels, 640, title);
    const swatches = Array.from(svg.children).filter((element) => element.tagName === "rect");
    const rows = new Set(swatches.map((swatch) => swatch.getAttribute("y")));
    expect(swatches).toHaveLength(10);
    expect(rows.size).toBe(2);
    const headerHeight = (title ? 28 : 0) + 48;
    expect(svg.querySelector("svg")?.getAttribute("y")).toBe(String(headerHeight));
    expect(svg.getAttribute("height")).toBe(String(200 + headerHeight));
    expect(svg.getAttribute("viewBox")).toBe(`0 0 640 ${200 + headerHeight}`);
    for (const label of labels) expect(svg.textContent).toContain(label);
  });

  it.each([64, 160, 320])("keeps long exported legend labels within a %ipx canvas", (width) => {
    const labels = [
      "A very long category label without losing any text",
      "W".repeat(80),
      "类别😀".repeat(16),
    ];
    const svg = exportedCategories(labels, width);
    const text = Array.from(svg.children).filter((element) => element.tagName === "text");
    expect(text).toHaveLength(labels.length);
    for (const label of labels) expect(text.map((element) => element.textContent)).toContain(label);
    for (const element of text) {
      const lines = Array.from(element.querySelectorAll("tspan"));
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(Number(line.getAttribute("x"))).toBeLessThan(width - 8);
      }
    }
    const plotY = Number(svg.querySelector("svg")?.getAttribute("y"));
    const lastText = text.at(-1)!;
    const lastBaseline = Number(lastText.getAttribute("y")) + (lastText.children.length - 1) * 16;
    expect(plotY).toBeGreaterThan(lastBaseline);
    expect(Number(svg.getAttribute("height"))).toBe(200 + plotY);
  });

  it("preserves single-row and legend-free export heights", () => {
    const singleRow = exportedCategories(["Adelie", "Chinstrap", "Gentoo"], 640, "Species");
    expect(singleRow.getAttribute("height")).toBe("252");
    expect(singleRow.querySelector("svg")?.getAttribute("y")).toBe("52");
    const noLegend = renderPlotSpecToSvg(
      { height: 200, marks: [{ type: "frame" }] },
      undefined,
      dom(),
    );
    const svg = new JSDOM(noLegend, { contentType: "image/svg+xml" }).window.document
      .documentElement;
    expect(svg.getAttribute("height")).toBe("200");
    expect(svg.querySelector("svg")?.getAttribute("y")).toBe("0");
  });

  it.each(["👨‍👩‍👧‍👦", "🇨🇦", "👍🏽", "1️⃣", "é"])(
    "keeps the natural size of the grapheme %j when it fits",
    (label) => {
      const svg = exportedCategories([label], 160);
      const line = svg.querySelector("text > tspan")!;
      expect(line.textContent).toBe(label);
      expect(line.parentElement?.children).toHaveLength(1);
      expect(line.hasAttribute("textLength")).toBe(false);
      expect(line.hasAttribute("lengthAdjust")).toBe(false);
      expect(line.hasAttribute("font-size")).toBe(false);
    },
  );

  it("wraps repeated joined emoji without splitting or enlarging their graphemes", () => {
    const grapheme = "👨‍👩‍👧‍👦";
    const svg = exportedCategories([grapheme.repeat(20)], 160);
    const text = svg.querySelector("text")!;
    const lines = Array.from(text.children);
    expect(text.textContent).toBe(grapheme.repeat(20));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const segments = Array.from(
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line.textContent!),
        ({ segment }) => segment,
      );
      expect(segments.length).toBeGreaterThan(1);
      expect(segments.every((segment) => segment === grapheme)).toBe(true);
      expect(line.hasAttribute("textLength")).toBe(false);
      expect(line.hasAttribute("font-size")).toBe(false);
    }
  });

  it("keeps joined emoji out of the PNG legend's right gutter with fallback fonts", async () => {
    const svg = exportedCategories(["👨‍👩‍👧‍👦".repeat(20)], 160);
    const png = await plotSvgToPng(svg.outerHTML);
    const sharp = (await import("sharp")).default;
    const metadata = await sharp(png).metadata();
    const scale = metadata.width! / 160;
    const plotY = Number(svg.querySelector("svg")?.getAttribute("y"));
    const gutter = await sharp(png)
      .removeAlpha()
      .extract({ left: 152 * scale, top: 0, width: 8 * scale, height: plotY * scale })
      .raw()
      .toBuffer();
    expect(gutter.every((channel) => channel === 255)).toBe(true);
  });

  it("does not charge a combining mark as another glyph on a narrow canvas", () => {
    const svg = exportedCategories(["é"], 40);
    const line = svg.querySelector("text > tspan")!;
    expect(line.textContent).toBe("é");
    expect(line.hasAttribute("font-size")).toBe(false);
    expect(line.hasAttribute("textLength")).toBe(false);
  });

  it("shrinks an oversized grapheme without splitting it or adding an empty row", () => {
    const label = "👨‍👩‍👧‍👦";
    const svg = exportedCategories([label], 40);
    const swatch = Array.from(svg.children).find((element) => element.tagName === "rect");
    const line = svg.querySelector("text > tspan")!;
    expect(swatch?.getAttribute("y")).toBe("5");
    expect(line.textContent).toBe(label);
    expect(line.parentElement?.children).toHaveLength(1);
    expect(line.hasAttribute("textLength")).toBe(false);
    expect(line.hasAttribute("lengthAdjust")).toBe(false);
    expect(Number(line.getAttribute("font-size"))).toBeGreaterThan(0);
    expect(Number(line.getAttribute("font-size"))).toBeLessThan(12);
    expect(svg.querySelector("svg")?.getAttribute("y")).toBe("24");
  });

  const xlink = "http://www.w3.org/1999/xlink";
  const linkedDot = { type: "dot", options: { x: "x", y: "y", href: "url" } };

  function expectInertLinks(element: Element) {
    const links = Array.from(element.querySelectorAll("a"));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.hasAttribute("href")).toBe(false);
      expect(link.hasAttributeNS(xlink, "href")).toBe(false);
      expect(link.childElementCount).toBeGreaterThan(0);
    }
  }

  it.each([
    "javascript:void(0)",
    "JaVaScRiPt:void(0)",
    " \u0000\u001fjavascript:void(0)",
    "java\tscr\ript:\nvoid(0)",
    "javascript:%76oid(0)",
    "data:text/html,<script>void(0)</script>",
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    "vbscript:msgbox(1)",
    "file:///example.txt",
    "blob:https://example.test/chart",
    "custom:launch",
    "https://[invalid",
  ])("makes unsafe or malformed chart links inert: %j", (url) => {
    const spec = { marks: [linkedDot] };
    const data = [{ x: 1, y: 2, url }];
    const { plotted } = buildPlotParts(spec, data, dom());
    expectInertLinks(plotted);
    expect(plotted.querySelectorAll("circle")).toHaveLength(1);
    const svg = renderPlotSpecToSvg(spec, data, dom());
    expectInertLinks(
      new JSDOM(svg, { contentType: "image/svg+xml" }).window.document.documentElement,
    );
    expect(data).toEqual([{ x: 1, y: 2, url }]);
    expect(linkedDot.options.href).toBe("url");
  });

  it.each([
    "https://example.test/chart?a=1&b=2",
    "HTTP://example.test/chart",
    "//example.test/chart",
    "/charts/1",
    "../charts/1",
    "?chart=1",
    "#details",
    "mailto:chart@example.test",
    "tel:+15555550123",
    // DOM attributes are not entity-decoded or percent-decoded into a scheme.
    "java&#x73;cript:void(0)",
    "javascript%3Avoid(0)",
    "java%73cript:void(0)",
  ])("preserves supported links without changing URL interpretation: %j", (url) => {
    const spec = { marks: [linkedDot] };
    const data = [{ x: 1, y: 2, url }];
    const { plotted } = buildPlotParts(spec, data, dom());
    expect(plotted.querySelector("a")?.getAttributeNS(xlink, "href")).toBe(url);
    const svg = renderPlotSpecToSvg(spec, data, dom());
    const parsed = new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
    const link = parsed.querySelector("a");
    expect(link?.getAttributeNS(xlink, "href") ?? link?.getAttribute("href")).toBe(url);
  });

  it("checks resolved links from nested, per-mark, array, scaled, and transformed channels", () => {
    const url = "javascript:void(0)";
    const data = [{ x: 1, y: 2, url }];
    const specs: PlotSpec[] = [
      { data, marks: [linkedDot] },
      { marks: [{ ...linkedDot, data }] },
      { data, marks: [{ type: "dot", options: { x: "x", y: "y", href: [url] } }] },
      {
        data,
        marks: [{ type: "dot", options: { x: "x", y: "y", href: { value: "url", scale: null } } }],
      },
      {
        data,
        color: { type: "ordinal", domain: [1], range: [url] },
        marks: [{ type: "dot", options: { x: "x", y: "y", href: { value: "x", scale: "color" } } }],
      },
      {
        data,
        marks: [
          { ...linkedDot, transform: { name: "groupX", outputs: { y: "sum", href: "first" } } },
        ],
      },
    ];
    for (const spec of specs) {
      expectInertLinks(buildPlotParts(spec, undefined, dom()).plotted);
    }
  });

  it.each([
    {
      position: "fixed",
      inset: "0",
      zIndex: "9999",
      background: "url(https://example.test/a.png)",
    },
    "position:fixed;inset:0;background:url(https://example.test/a.png)",
  ])("ignores page styles on the chart: %j", (style) => {
    const spec = { style, className: "flex", marks: [linkedDot] } as unknown as PlotSpec;
    const data = [{ x: 1, y: 2, url: "https://example.test" }];
    const { plotted } = buildPlotParts(spec, data, dom());
    expect(plotted.getAttribute("style") ?? "").not.toMatch(/fixed|url\(/);
    expect(plotted.outerHTML).not.toContain(".flex");
    expect(plotted.getAttribute("class")).not.toBe("flex");
    const svg = renderPlotSpecToSvg(spec, data, dom());
    expect(svg).not.toMatch(/fixed|url\(https|\.flex/);
  });

  it("keeps link targets and remote url() references out of the chart", () => {
    const remote = "url(https://example.test/paint.svg#p)";
    const spec: PlotSpec = {
      color: { type: "ordinal", domain: ["a"], range: [remote] },
      marks: [
        {
          type: "dot",
          options: { x: "x", y: "y", fill: remote, href: "url", target: "_top", className: "flex" },
        },
        { type: "dot", options: { x: "x", y: "y", stroke: "k", imageFilter: remote, clip: true } },
      ],
    };
    const data = [{ x: 1, y: 2, k: "a", url: "https://example.test" }];
    const { plotted, swatches } = buildPlotParts(spec, data, dom());
    expect(swatches).toEqual([]);
    expect(plotted.querySelector("a")?.hasAttribute("target")).toBe(false);
    expect(plotted.querySelector(".flex")).toBeNull();
    expect(plotted.outerHTML).not.toContain("example.test/paint");
    expect(plotted.querySelector("[clip-path]")?.getAttribute("clip-path")).toMatch(/^url\(#/);
    expect(renderPlotSpecToSvg(spec, data, dom())).not.toContain("example.test/paint");
  });

  it("supports transforms: binned histogram and grouped stacked bars", () => {
    const histogram = renderPlotSpecToSvg(
      {
        marks: [
          {
            type: "rectY",
            transform: { name: "binX", outputs: { y: "count" } },
            options: { x: "length", fill: "species" },
          },
          { type: "ruleY", data: [0] },
        ],
      },
      penguinish,
      dom(),
    );
    expect(histogram).toContain("rect");
    const grouped = renderPlotSpecToSvg(
      {
        marks: [
          {
            type: "barY",
            transform: { name: "groupX", outputs: { y: "count" } },
            options: { x: "island", fill: "species" },
          },
        ],
      },
      penguinish,
      dom(),
    );
    expect(grouped).toContain("rect");
  });

  it("supports facets", () => {
    const svg = renderPlotSpecToSvg(
      {
        marks: [{ type: "dot", options: { x: "length", y: "depth", fx: "island" } }],
      },
      penguinish,
      dom(),
    );
    for (const island of ["Torgersen", "Dream", "Biscoe"]) expect(svg).toContain(island);
  });

  it("rejects unknown marks and transforms with the supported lists", () => {
    expect(() => renderPlotSpecToSvg({ marks: [{ type: "evilMark" }] }, penguinish, dom())).toThrow(
      /Unsupported mark type "evilMark"/,
    );
    expect(() =>
      renderPlotSpecToSvg(
        { marks: [{ type: "dot", transform: { name: "eval" }, options: {} }] },
        penguinish,
        dom(),
      ),
    ).toThrow(/Unsupported transform "eval"/);
    expect(supportedPlotNames().marks).toContain("dot");
    expect(supportedPlotNames().marks).not.toContain("image");
    expect(supportedPlotNames().transforms).toContain("binX");
    expect(() =>
      renderPlotSpecToSvg(
        { marks: [{ type: "image", options: { src: "https://example.test/pixel.png" } }] },
        [{ x: 1, y: 1 }],
        dom(),
      ),
    ).toThrow(/Unsupported mark type "image"/);
  });

  it("rejects empty data and channel names that match no column", () => {
    expect(() =>
      renderPlotSpecToSvg({ marks: [{ type: "barY", options: { x: "q", y: "v" } }] }, [], dom()),
    ).toThrow(/empty data array/);
    expect(() =>
      renderPlotSpecToSvg(
        { marks: [{ type: "barY", options: { x: "Quarter", y: "Sales" } }] },
        [{ quarter: "Q1", sales: 120 }],
        dom(),
      ),
    ).toThrow(/x refers to "Quarter" but the data columns are: quarter, sales/);
    expect(() =>
      renderPlotSpecToSvg({ marks: [{ type: "barY" }] }, [{ quarter: "Q1", sales: 120 }], dom()),
    ).toThrow(/no position channels/);
  });

  it("coerces numeric strings so bar heights measure instead of stacking ordinally", () => {
    const svg = renderPlotSpecToSvg(
      { marks: [{ type: "barY", options: { x: "quarter", y: "sales" } }] },
      [
        { quarter: "Q1", sales: "120" },
        { quarter: "Q2", sales: "185" },
        { quarter: "Q3", sales: "143" },
        { quarter: "Q4", sales: "210" },
      ],
      dom(),
    );
    // A quantitative y axis includes a 200 tick; the ordinal failure mode has none.
    expect(svg).toContain("200");
    expect(svg).toContain("Q3");
  });

  it("preserves numeric-looking category labels", () => {
    const svg = renderPlotSpecToSvg(
      { marks: [{ type: "barY", options: { x: "code", y: "sales" } }] },
      [
        { code: "007", sales: "120" },
        { code: "1e5", sales: "185" },
      ],
      dom(),
    );

    expect(svg).toContain("007");
    expect(svg).toContain("1e5");
  });

  it("parses data given as CSV text lines", () => {
    const svg = renderPlotSpecToSvg(
      { marks: [{ type: "barY", options: { x: "quarter", y: "sales" } }] },
      ["quarter,sales", "Q1,120", "Q2,185", "Q3,143", "Q4,210"],
      dom(),
    );
    expect(svg).toContain("200");
    expect(svg).toContain("Q3");
  });

  it("accepts rows nested inside the spec as data", () => {
    const svg = renderPlotSpecToSvg(
      {
        data: [
          { quarter: "Q1", sales: 120 },
          { quarter: "Q2", sales: 185 },
        ],
        marks: [{ type: "barY", options: { x: "quarter", y: "sales" } }],
      },
      undefined,
      dom(),
    );
    expect(svg).toContain("rect");
    expect(svg).toContain("Q2");
  });

  it("rejects oversized data across top-level, spec, and per-mark arrays", () => {
    const rows = Array.from({ length: 2_501 }, (_, x) => ({ x }));

    expect(() =>
      renderPlotSpecToSvg(
        {
          data: rows,
          marks: [{ type: "dot", data: rows, options: { x: "x" } }],
        },
        undefined,
        dom(),
      ),
    ).toThrow(/5,000-row limit/);
  });

  it("parses csv with automatic typing and json row arrays", () => {
    const rows = parsePlotData("data.csv", "a,b\n1,2024-01-05\n2,2024-02-05\n") as {
      a: number;
      b: Date;
    }[];
    expect(rows[0]?.a).toBe(1);
    expect(rows[0]?.b instanceof Date).toBe(true);
    expect(parsePlotData("rows.json", '[{"x":1}]')).toEqual([{ x: 1 }]);
    expect(() => parsePlotData("rows.json", '{"x":1}')).toThrow(/top-level array/);
  });

  it("renders every chart catalog example spec verbatim", () => {
    for (const entry of CHART_CATALOG) {
      const svg = renderPlotSpecToSvg(entry.spec, undefined, dom());
      expect(svg.startsWith("<svg"), `catalog entry "${entry.name}" must render`).toBe(true);
    }
    expect(CHART_CATALOG.length).toBeGreaterThanOrEqual(18);
  });

  it("searches the chart catalog by keyword and falls back to the full list", () => {
    const hist = searchChartCatalog("distribution");
    expect(hist.map((entry) => entry.name)).toContain("histogram");
    expect(hist.length).toBeLessThan(CHART_CATALOG.length);
    expect(searchChartCatalog("qzx-no-match")).toHaveLength(CHART_CATALOG.length);
    expect(searchChartCatalog(undefined)).toHaveLength(CHART_CATALOG.length);
  });

  it("rasterizes to a fully opaque PNG (no transparent background)", async () => {
    const { plotSvgToPng } = await import("./plot-tool.js");
    const svg = renderPlotSpecToSvg(
      { marks: [{ type: "barY", options: { x: "species", y: "length" } }] },
      penguinish,
      dom(),
    );
    const png = await plotSvgToPng(svg);
    const sharp = (await import("sharp")).default;
    const stats = await sharp(png).stats();
    const meta = await sharp(png).metadata();
    const alpha = stats.channels[3];
    expect(meta.channels === 3 || (alpha && alpha.min === 255)).toBe(true);
  });
});
