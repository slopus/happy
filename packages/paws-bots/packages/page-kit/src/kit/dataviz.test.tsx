// @vitest-environment jsdom

import type { ReactElement } from "react";
import { act, Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bars, LineChart, Pie } from "./charts.js";
import { Metrics, Status, Table } from "./data.js";
import {
  CalendarHeatmap,
  ColumnSeries,
  Columns,
  formatValue,
  Heatmap,
  Matrix2x2,
  Scatter,
  SourceStamp,
  StackedBars,
  shade,
  Venn,
} from "./dataviz.js";
import { Page } from "./layout.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const key = (target: Element, name: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
const pointer = (target: Element, type: string, pointerType = "touch") =>
  act(() => {
    const event = new MouseEvent(type, { bubbles: true, clientX: 100, clientY: 50 });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    target.dispatchEvent(event);
  });
const tip = (root: Element) => root.querySelector(".rk-tip")?.textContent ?? null;
/** Charts measure their box; jsdom has none, so each observed box reports this width. */
function stubWidth(width: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private report: (entries: unknown[]) => void) {}
      observe() {
        this.report([{ contentRect: { width } }]);
      }
      disconnect() {}
    },
  );
}
const ticks = (root: Element) =>
  [...root.querySelectorAll('text.rk-tick[text-anchor="end"]')].map((t) => t.textContent);

describe("charts", () => {
  it("draws columns with their values, inks the largest, and reads one out from the keyboard", () => {
    const points = [
      { label: "Jan", value: 12 },
      { label: "Feb", value: 35, display: "$35k" },
      { label: "Mar", value: 20 },
    ];
    const root = mount(<Columns points={points} />);
    const groups = [...root.querySelectorAll("svg > g")];
    expect(groups.map((g) => g.hasAttribute("data-emphasis"))).toEqual([false, true, false]);
    expect(root.textContent).toContain("$35k");
    const svg = root.querySelector('svg[role="img"]')!;
    expect(tip(root)).toBeNull();
    key(svg, "ArrowRight");
    key(svg, "ArrowRight");
    expect(tip(root)).toBe("Feb$35k");
    key(svg, "Escape");
    expect(tip(root)).toBeNull();
    const chosen = mount(<Columns points={points} emphasis="none" />);
    expect(chosen.querySelectorAll("svg > g[data-emphasis]")).toHaveLength(3);
    expect(mount(<Columns points={[]} />).textContent).toBe("No data");
  });

  it("keeps a touch selection after release and dismisses it outside the chart", () => {
    const root = mount(<Columns points={[{ label: "Jan", value: 12 }]} />);
    const svg = root.querySelector('svg[role="img"]')!;
    key(svg, "Home");
    pointer(svg, "pointerdown");
    expect(tip(root)).toBe("Jan12");
    pointer(svg, "pointerup");
    pointer(svg, "pointerout");
    expect(tip(root)).toBe("Jan12");
    pointer(document.body, "pointerdown");
    expect(tip(root)).toBeNull();

    pointer(svg, "pointerdown");
    pointer(svg, "pointercancel");
    pointer(svg, "pointerout");
    expect(tip(root)).toBeNull();
    pointer(svg, "pointerdown");
    key(svg, "Escape");
    expect(tip(root)).toBeNull();
    pointer(svg, "pointermove", "mouse");
    expect(tip(root)).toBe("Jan12");
    pointer(svg, "pointerout", "mouse");
    expect(tip(root)).toBeNull();
    key(svg, "Home");
    expect(tip(root)).toBe("Jan12");
    act(() => svg.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(tip(root)).toBeNull();
  });

  it("moves touch selection between charts without leaving the first tip open", () => {
    const root = mount(
      <>
        <Columns points={[{ label: "Jan", value: 12 }]} />
        <Columns points={[{ label: "Feb", value: 35 }]} />
      </>,
    );
    const [first, second] = root.querySelectorAll('svg[role="img"]');
    pointer(first!, "pointerdown");
    pointer(first!, "pointerout");
    expect(tip(root)).toBe("Jan12");
    pointer(second!, "pointerdown");
    pointer(second!, "pointerout");
    expect(root.querySelectorAll(".rk-tip")).toHaveLength(1);
    expect(tip(root)).toBe("Feb35");
    pointer(document.body, "pointerdown");
    expect(tip(root)).toBeNull();
  });

  it("stacks series to a round ceiling, marks a reference and totals the stack in its tip", () => {
    const root = mount(
      <ColumnSeries
        stacked
        labels={["Jan", "Feb"]}
        unit="k"
        reference={{ value: 30, label: "Target" }}
        series={[
          { name: "Web", values: [20, 25] },
          { name: "iOS", values: [10, 26] },
        ]}
      />,
    );
    // 51 at the top rounds up to 60, with its middle at 30.
    expect(ticks(root)).toEqual(["0k", "30k", "60k"]);
    expect(root.querySelector(".rk-reference-label")!.textContent).toBe("Target");
    expect([...root.querySelectorAll(".rk-key-item")].map((i) => i.textContent)).toEqual([
      "Web",
      "iOS",
    ]);
    // Stacked columns key their series with dots, side-by-side ones with strokes.
    expect(root.querySelectorAll(".rk-key-dot")).toHaveLength(2);
    key(root.querySelector('svg[role="img"]')!, "End");
    expect(tip(root)).toBe("FebWeb25kiOS26kTotal51k");
    const grouped = mount(
      <ColumnSeries
        labels={["A"]}
        series={[
          { name: "x", values: [1] },
          { name: "y", values: [2] },
        ]}
        format={(v) => `$${v}`}
      />,
    );
    expect(grouped.querySelectorAll(".rk-key-line")).toHaveLength(2);
    expect(ticks(grouped)).toEqual(["$0", "$1", "$2"]);
    const quarter = mount(<ColumnSeries labels={["A"]} series={[{ name: "x", values: [25] }]} />);
    expect(ticks(quarter)).toEqual(["0", "12.5", "25"]);
    expect(
      mount(<ColumnSeries labels={["A"]} series={[{ name: "x", values: [0] }]} />).textContent,
    ).toBe("No data");
  });

  it("keeps side-by-side columns at a positive width however many labels share the plot", () => {
    const labels = Array.from({ length: 300 }, (_, index) => `d${index}`);
    const values = labels.map((_, index) => index + 1);
    const dense = mount(
      <ColumnSeries
        labels={labels}
        series={[
          { name: "a", values },
          { name: "b", values },
          { name: "c", values },
        ]}
      />,
    );
    const widths = [...dense.querySelectorAll("path[d^='M']")].flatMap((path) => {
      const match = /^M(-?[\d.]+) [-\d.]+H(-?[\d.]+)/.exec(path.getAttribute("d")!);
      return match ? [Number(match[2]) - Number(match[1])] : [];
    });
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.filter((width) => width < -1e-9)).toEqual([]);
  });

  it("splits each stacked bar by its parts and writes the total or the given display", () => {
    const root = mount(
      <StackedBars
        series={["Done", "Open"]}
        bars={[
          { label: "Design", values: [6, 2] },
          { label: "Backend", values: [12, 4], display: "16 tasks" },
        ]}
      />,
    );
    expect([...root.querySelectorAll(".rk-stacked-value")].map((v) => v.textContent)).toEqual([
      "8",
      "16 tasks",
    ]);
    const widths = [...root.querySelectorAll<HTMLElement>(".rk-stacked-bar")].map(
      (bar) => bar.style.width,
    );
    expect(widths[0]).toContain("0.5 *");
    expect(widths[1]).toContain("1 *");
    const parts = root.querySelectorAll<HTMLElement>(".rk-stacked-part");
    expect([...parts].map((part) => part.style.flexGrow)).toEqual(["6", "2", "12", "4"]);
    expect(root.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe(
      "Design: Done 6, Open 2; Backend: Done 12, Open 4",
    );
    const huge = mount(<StackedBars bars={[{ label: "a", values: [1e308, 1e308] }]} />);
    expect(huge.innerHTML).not.toContain("NaN");
    expect(huge.querySelector(".rk-stacked-bar")).toBeNull();
  });

  it("plots dots by series and size, fits a trend only when asked and labels the outlier", () => {
    const points = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 4 },
      { x: 5, y: 12, label: "Spike", series: "B", size: 9 },
      { x: 6, y: 6 },
      { x: 7, y: 7 },
    ];
    const plain = mount(<Scatter points={points} x={{ name: "Spend" }} y={{ name: "Revenue" }} />);
    expect(plain.querySelector(".rk-trend")).toBeNull();
    expect(plain.querySelector(".rk-outlier")).toBeNull();
    const radii = [...plain.querySelectorAll("circle.rk-dot")].map((c) => c.getAttribute("r"));
    expect(radii).toContain("8");
    expect(radii.filter((r) => r === "3")).toHaveLength(6);
    const fitted = mount(<Scatter points={points} trend />);
    expect(fitted.querySelector(".rk-trend")).not.toBeNull();
    expect([...fitted.querySelectorAll(".rk-outlier")].map((t) => t.textContent)).toEqual([
      "Spike",
    ]);
    key(fitted.querySelector('svg[role="img"]')!, "ArrowRight");
    expect(tip(fitted)).toBe("x1y1");
    expect(mount(<Scatter points={[{ x: Number.NaN, y: 1 }]} />).textContent).toBe("No data");
  });

  it("shades heatmap cells in five steps of the largest value and leaves zero unshaded", () => {
    expect([0, 1, 4, 6, 9, -2, Number.NaN].map((v) => shade(v, 9))).toEqual([
      undefined,
      1,
      3,
      4,
      5,
      undefined,
      undefined,
    ]);
    const root = mount(
      <Heatmap
        rows={["Mon", "Tue"]}
        columns={["9a", "1p"]}
        values={[
          [1, 9],
          [0, 4],
        ]}
      />,
    );
    const cells = [...root.querySelectorAll<HTMLElement>(".rk-heatmap-cell")];
    expect(cells.map((cell) => cell.style.background)).toEqual([
      "var(--rk-seq1)",
      "var(--rk-seq5)",
      "var(--rk-fill-strong)",
      "var(--rk-seq3)",
    ]);
    const grid = root.querySelector(".rk-heatmap")!;
    // The first key lands on the first cell; then right one and down one row.
    key(grid, "ArrowRight");
    key(grid, "ArrowRight");
    key(grid, "ArrowDown");
    expect(tip(root)).toBe("Tue · 1p4");
    expect(mount(<Heatmap rows={["a"]} columns={["b"]} values={[]} />).textContent).toBe("No data");
  });

  it("fits a whole day of hours on a phone by thinning the hour labels, and keeps all of them wide", () => {
    stubWidth(342);
    const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
    const day = <Heatmap rows={["Mon"]} columns={hours} values={[hours.map(Number)]} />;
    const labels = (root: Element) =>
      [...root.querySelectorAll(".rk-heatmap-column")].map((label) => label.textContent);
    const phone = mount(day);
    expect(labels(phone)).toEqual(hours.map((hour, h) => (h % 2 === 0 ? hour : "")));
    expect(phone.querySelector(".rk-heatmap")!.hasAttribute("data-thin")).toBe(true);
    // Every hour keeps its name for the tip and assistive tech.
    expect(phone.querySelectorAll(".rk-heatmap-column[title]")).toHaveLength(24);
    stubWidth(1000);
    const wide = mount(day);
    expect(labels(wide)).toEqual(hours);
    expect(wide.querySelector(".rk-heatmap")!.hasAttribute("data-thin")).toBe(false);
  });

  it("lays days out in Monday-first week columns and names each month once", () => {
    const root = mount(
      <CalendarHeatmap
        note="Commits"
        days={[
          { date: "2026-03-02", value: 3 },
          { date: "2026-03-08", value: 1 },
          { date: "2026-03-09", value: 0 },
          { date: "not a date", value: 5 },
          { date: "2026-04-01", value: 2 },
        ]}
      />,
    );
    const days = [...root.querySelectorAll<HTMLElement>(".rk-day")];
    expect(days).toHaveLength(31);
    // 2 March 2026 is a Monday: first week column, first weekday row.
    expect(days[0]!.style.gridRow).toBe("2");
    expect(days[0]!.style.gridColumn).toBe("2");
    // The Sunday after sits at the bottom of the same week; the next Monday starts a new one.
    expect(days[6]!.style.gridRow).toBe("8");
    expect(days[7]!.style.gridColumn).toBe("3");
    expect([...root.querySelectorAll(".rk-calendar-month")].map((m) => m.textContent)).toEqual([
      "Mar",
      "Apr",
    ]);
    expect(root.textContent).toContain("Commits");
    expect(mount(<CalendarHeatmap days={[]} />).textContent).toBe("No data");
    // A day the calendar does not have is no day at all, not the one it would roll into.
    expect(mount(<CalendarHeatmap days={[{ date: "2026-02-30", value: 1 }]} />).textContent).toBe(
      "No data",
    );
  });

  it("names up to three sets beside their circles with the shared figure in the middle", () => {
    const root = mount(
      <Venn
        sets={[
          { label: "Email", count: 4200 },
          { label: "SMS", items: ["a", "b"] },
          { label: "Push", count: 150 },
          { label: "Fourth", count: 1 },
        ]}
        overlap="38"
      />,
    );
    expect(root.querySelectorAll(".rk-venn-set")).toHaveLength(3);
    expect([...root.querySelectorAll(".rk-venn-count")].map((t) => t.textContent)).toEqual([
      "4,200",
      "2",
      "150",
    ]);
    expect(root.querySelector(".rk-venn-overlap")!.textContent).toBe("38");
    expect(root.textContent).not.toContain("Fourth");
    expect(mount(<Venn sets={[]} />).textContent).toBe("No data");
    // A long shared note wraps inside the middle instead of running across both circles.
    const long = mount(
      <Venn sets={[{ label: "A" }, { label: "B" }]} overlap="312 (cookie resets, excluded)" />,
    );
    const lines = [...long.querySelectorAll(".rk-venn-overlap tspan")].map((t) => t.textContent);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("312 (cookie resets, excluded)");
  });

  it("places matrix items by their 0 to 1 position, clamped, under four quadrant names", () => {
    const root = mount(
      <Matrix2x2
        axes={{ x: ["Low effort", "High effort"], y: ["Low impact", "High impact"] }}
        quadrants={["Quick wins", "Big bets", "Fill-ins", "Money pits"]}
        points={[
          { label: "SSO", x: 0.7, y: 0.9 },
          { label: "Wild", x: 3, y: -1 },
        ]}
      />,
    );
    const placed = [...root.querySelectorAll<HTMLElement>(".rk-matrix-point")];
    expect(placed.map((p) => [p.style.left, p.style.top])).toEqual([
      ["70%", "10%"],
      ["100%", "100%"],
    ]);
    expect(placed[1]!.hasAttribute("data-flip")).toBe(true);
    expect(root.textContent).toContain("High effort");
    expect(root.textContent).toContain("Low impact");
    expect(root.querySelectorAll(".rk-matrix-quadrant")).toHaveLength(4);
  });

  it("dates a source as live, as a snapshot, while updating, or after a failed refresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    const live = mount(<SourceStamp source={{ asOf: "2026-10-31T11:58:00Z", fresh: true }} />);
    expect(live.textContent).toBe("Updated 2 minutes ago");
    act(() => vi.advanceTimersByTime(60_000));
    expect(live.textContent).toBe("Updated 3 minutes ago");
    expect(
      mount(<SourceStamp source={{ asOf: "2026-10-30T09:00:00Z", fresh: false }} />).textContent,
    ).toBe("As of Oct 30, 2026");
    expect(
      mount(<SourceStamp source={{ asOf: "2026-10-30T09:00:00Z", updating: true }} />).textContent,
    ).toBe("As of Oct 30, 2026Updating…");
    expect(
      mount(
        <SourceStamp
          source={{
            asOf: "2026-10-30T09:00:00Z",
            error: "Reconnect Stripe to see live data",
          }}
        />,
      ).textContent,
    ).toContain("Reconnect Stripe to see live data");
    expect(
      mount(<SourceStamp source={{ asOf: "2026-10-30T09:00:00Z", error: "HTTP 500" }} />)
        .textContent,
    ).toContain("Refresh failed, showing last value");
    expect(mount(<SourceStamp source={{}} />).textContent).toBe("");
  });

  it.each(["America/New_York", "America/Los_Angeles", "Asia/Tokyo"])(
    "preserves date-only snapshots while localizing timestamps in %s",
    (timeZone) => {
      const DateTimeFormat = Intl.DateTimeFormat;
      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
        class extends DateTimeFormat {
          constructor(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
            super(locales, { timeZone, ...options });
          }
        },
      );

      expect(mount(<SourceStamp source={{ asOf: "2026-10-30" }} />).textContent).toBe(
        "As of Oct 30, 2026",
      );
      const timestamp = "2026-10-30T00:00:00Z";
      const expected = new DateTimeFormat("en", { dateStyle: "medium", timeZone }).format(
        Date.parse(timestamp),
      );
      expect(mount(<SourceStamp source={{ asOf: timestamp }} />).textContent).toBe(
        `As of ${expected}`,
      );
    },
  );

  it("formats figures with their unit and survives a formatter that throws", () => {
    expect(formatValue(30, "%")).toBe("30%");
    expect(formatValue(-12, "$")).toBe("-$12");
    expect(formatValue(80, "K")).toBe("80K");
    expect(formatValue(120, "ms")).toBe("120 ms");
    expect(formatValue(12.5)).toBe("12.5");
    expect(formatValue(1_250_000)).toBe("1.3M");
    expect(
      formatValue(3, "k", () => {
        throw new Error("bad");
      }),
    ).toBe("3k");
  });
});

describe("line chart", () => {
  it("adds series with dots, a dashed comparison, gaps for missing values and pinned notes", () => {
    const root = mount(
      <LineChart
        points={[
          { label: "Jan", value: 10 },
          { label: "Feb", value: Number.NaN },
          { label: "Mar", value: 14 },
        ]}
        labels={["Plan A"]}
        lines={[{ label: "Plan B", values: [8, 9, 11] }]}
        secondary={{ label: "Last year", values: [6, 7, 8] }}
        annotations={[{ at: 2, label: "Launch" }]}
        unit="%"
      />,
    );
    expect([...root.querySelectorAll(".rk-key-item")].map((i) => i.textContent)).toEqual([
      "Plan A",
      "Plan B",
      "Last year",
    ]);
    const [first] = [...root.querySelectorAll("path.rk-line")].map((p) => p.getAttribute("d")!);
    expect(first!.match(/M/g)).toHaveLength(2);
    expect(root.querySelectorAll("circle.rk-line-dot")).toHaveLength(5);
    expect(root.querySelector(".rk-line-secondary")).not.toBeNull();
    expect(root.querySelector(".rk-line-area")).toBeNull();
    expect(root.querySelector(".rk-annotation")!.textContent).toBe("Launch");
    key(root.querySelector('svg[role="img"]')!, "Home");
    expect(tip(root)).toBe("JanPlan A10%Plan B8%Last year6%");
    const single = mount(<LineChart points={[{ value: 1 }, { value: 2 }]} />);
    expect(single.querySelector(".rk-line-area")).not.toBeNull();
    expect(mount(<LineChart points={[]} />).textContent).toBe("No data");
  });

  it("measures its box again after going empty and coming back, and lets go on unmount", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private report: (entries: unknown[]) => void) {}
        observe() {
          observe();
          this.report([{ contentRect: { width: 300 } }]);
        }
        disconnect() {
          disconnect();
        }
      },
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    for (const data of [[], [10, 20], [], [20, 30]])
      act(() => root.render(<LineChart points={data.map((value) => ({ value }))} />));
    expect(observe).toHaveBeenCalledTimes(2);
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toContain("300");
    act(() => root.unmount());
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});

describe("line chart x labels", () => {
  it("spaces up to five day labels evenly with the ends inward, and fewer when a card is narrow", () => {
    const month = Array.from({ length: 30 }, (_, day) => ({ label: `Oct ${day + 1}`, value: day }));
    const xLabels = (root: Element) =>
      [...root.querySelectorAll("text.rk-tick")]
        .filter((tick) => tick.textContent?.startsWith("Oct"))
        .map((tick) => [tick.textContent, tick.getAttribute("text-anchor")]);
    stubWidth(560);
    expect(xLabels(mount(<LineChart points={month} />))).toEqual([
      ["Oct 1", "start"],
      ["Oct 9", "middle"],
      ["Oct 17", "middle"],
      ["Oct 25", "middle"],
      ["Oct 30", "end"],
    ]);
    stubWidth(210);
    expect(xLabels(mount(<LineChart points={month} />))).toEqual([
      ["Oct 1", "start"],
      ["Oct 13", "middle"],
      ["Oct 30", "end"],
    ]);
  });
});

describe("line chart sparse labels", () => {
  it("thins among the labelled points, and leaves a missing value as a gap, not zero", () => {
    const weeks = ["W1", "", "W2", "", "W3", "", "W4", "", "", "", "", ""];
    const values = [92, 108, 86, 124, 110, 119, 103, null, null, null, null, null];
    stubWidth(560);
    const root = mount(
      <LineChart
        points={weeks.map((label, i) => ({ label, value: values[i] as number }))}
        floor={0}
      />,
    );
    expect(
      [...root.querySelectorAll("text.rk-tick")]
        .map((tick) => tick.textContent)
        .filter((text) => text?.startsWith("W")),
    ).toEqual(["W1", "W2", "W3", "W4"]);
    // The line stops at the last value instead of dropping to the baseline.
    const line = root.querySelector("path.rk-line")!.getAttribute("d")!;
    expect(line.match(/[ML]/g)).toHaveLength(7);
    // A note on a missing value still shows, and one at the right edge reads inward.
    const noted = mount(
      <LineChart
        points={weeks.map((label, i) => ({ label, value: values[i] as number }))}
        annotations={[
          { at: 9, label: "Billing paused" },
          { at: 6, label: "Pricing change" },
        ]}
      />,
    );
    const notes = [...noted.querySelectorAll(".rk-annotation text")];
    expect(notes.map((note) => note.textContent)).toEqual(["Billing paused", "Pricing change"]);
    const edge = mount(
      <LineChart
        points={[{ value: 1 }, { value: 2 }, { value: 3 }]}
        annotations={[{ at: 2, label: "Pricing change" }]}
      />,
    );
    expect(edge.querySelector(".rk-annotation text")!.getAttribute("text-anchor")).toBe("end");
  });
});

describe("columns", () => {
  it("draws the baseline and says so when every value is zero", () => {
    const root = mount(
      <Columns
        points={[
          { label: "Mon", value: 0 },
          { label: "Tue", value: 0 },
        ]}
      />,
    );
    expect(root.querySelector("line.rk-grid-line")).not.toBeNull();
    expect(root.textContent).toContain("All values are 0");
    const some = mount(
      <Columns
        points={[
          { label: "Mon", value: 0 },
          { label: "Tue", value: 3 },
        ]}
      />,
    );
    expect(some.textContent).not.toContain("All values are 0");
  });
});

describe("data display", () => {
  it("draws a negative bar in the negative colour at its size", () => {
    const root = mount(
      <Bars
        bars={[
          { label: "Gain", value: 50 },
          { label: "Loss", value: -100, display: "-$100" },
        ]}
      />,
    );
    const rows = [...root.querySelectorAll("li")];
    expect(rows[1]!.hasAttribute("data-negative")).toBe(true);
    expect(rows[0]!.hasAttribute("data-negative")).toBe(false);
    expect(
      [...root.querySelectorAll<HTMLElement>(".rk-bar-fill")].map((f) => f.style.width),
    ).toEqual(["50%", "100%"]);
    // The longest bar is inked, whichever side of zero it falls on.
    expect(rows.map((row) => row.getAttribute("data-emphasis"))).toEqual(["false", "true"]);
    const losses = mount(
      <Bars
        bars={[
          { label: "Small", value: -5 },
          { label: "Big", value: -10 },
        ]}
      />,
    );
    expect(
      [...losses.querySelectorAll("li")].map((row) => row.getAttribute("data-emphasis")),
    ).toEqual(["false", "true"]);
  });

  it("shows a donut's total and label in the middle and folds slivers when there are many", () => {
    const root = mount(
      <Pie
        total
        label="Users"
        parts={[
          { label: "Starter", value: 540 },
          { label: "Pro", value: 400 },
        ]}
      />,
    );
    expect(root.querySelector(".rk-pie-total")!.textContent).toBe("940Users");
    const many = Array.from({ length: 10 }, (_, i) => ({
      label: `P${i}`,
      value: i < 8 ? 100 : 1,
    }));
    const folded = mount(<Pie parts={many} />);
    const labels = [...folded.querySelectorAll(".rk-pie-label")].map((l) => l.textContent);
    expect(labels).toHaveLength(9);
    expect(labels.at(-1)).toBe("Other");
    // Parts whose total overflows draw nothing rather than NaN slices.
    const huge = mount(
      <Pie
        parts={[
          { label: "a", value: 1e308 },
          { label: "b", value: 1e308 },
        ]}
      />,
    );
    expect(huge.innerHTML).not.toContain("NaN");
    expect(huge.querySelector("svg")).toBeNull();
  });

  it("marks a delta up or down, coloured by which way is good, and draws an optional trend", () => {
    const root = mount(
      <Metrics
        metrics={[
          { value: "$48,900", label: "Revenue", delta: "+12%", detail: "vs last month" },
          { value: "2.1%", label: "Churn", delta: "+0.3pt", better: "down" },
          { value: "398", label: "Users", delta: -3, trend: [1, 3, 2, 5] },
          { value: "4.8%", label: "Trial to paid" },
        ]}
      />,
    );
    const deltas = [...root.querySelectorAll(".rk-delta")];
    expect(deltas.map((d) => d.className)).toEqual([
      "rk-delta rk-tone-success",
      "rk-delta rk-tone-danger",
      "rk-delta rk-tone-danger",
    ]);
    expect(deltas.map((d) => d.textContent)).toEqual(["Up 12%", "Up 0.3pt", "Down 3"]);
    expect(root.textContent).toContain("vs last month");
    expect(root.querySelectorAll(".rk-spark polyline")).toHaveLength(1);
  });

  it("refreshes table fades when the mounted page changes language", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          direction: element.closest("main")?.getAttribute("dir") ?? "ltr",
        }) as CSSStyleDeclaration,
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    const render = (lang: string) =>
      act(() =>
        root.render(
          <Page title="Table" lang={lang}>
            <Table columns={["Name"]} rows={[["Alpha"]]} />
          </Page>,
        ),
      );
    render("en");
    const scroll = container.querySelector(".rk-table-scroll")!;
    expect(scroll.hasAttribute("data-fade-start")).toBe(false);
    expect(scroll.hasAttribute("data-fade-end")).toBe(true);
    render("he");
    expect(container.querySelector(".rk-table-scroll")).toBe(scroll);
    expect(scroll.hasAttribute("data-fade-start")).toBe(true);
    expect(scroll.hasAttribute("data-fade-end")).toBe(false);
    render("en");
    expect(scroll.hasAttribute("data-fade-start")).toBe(false);
    expect(scroll.hasAttribute("data-fade-end")).toBe(true);
  });

  it.each(["ltr", "rtl"])("fades the physical hidden edges in %s tables", (direction) => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ direction } as CSSStyleDeclaration);
    const container = mount(<Table columns={["Name"]} rows={[["Alpha"]]} />);
    const scroll = container.querySelector<HTMLDivElement>(".rk-table-scroll")!;
    const edges = () => [
      scroll.hasAttribute("data-fade-start"),
      scroll.hasAttribute("data-fade-end"),
    ];
    const move = (left: number) =>
      act(() => {
        scroll.scrollLeft = left;
        scroll.dispatchEvent(new Event("scroll"));
      });
    const rtl = direction === "rtl";
    expect(edges()).toEqual([rtl, !rtl]);
    move(rtl ? -100 : 100);
    expect(edges()).toEqual([true, true]);
    move(rtl ? -200 : 200);
    expect(edges()).toEqual([!rtl, rtl]);
    // Elastic overscroll must not light up the edge already reached.
    move(rtl ? -220 : 220);
    expect(edges()).toEqual([!rtl, rtl]);
    move(rtl ? 20 : -20);
    expect(edges()).toEqual([rtl, !rtl]);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(100);
    move(0);
    expect(edges()).toEqual([false, false]);
  });

  it.each([false, true])(
    "tracks scroll edges when an empty table appears (strict: %s)",
    (strict) => {
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
      const observers: { update: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          disconnect = vi.fn();
          constructor(update: () => void) {
            observers.push({ update, disconnect: this.disconnect });
          }
          observe() {}
        },
      );
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      mounted.push(() => {
        act(() => root.unmount());
        container.remove();
      });
      const draw = (visible: boolean) =>
        act(() => {
          const table = (
            <Table columns={visible ? ["Name"] : []} rows={visible ? [["Alpha"]] : []} />
          );
          root.render(strict ? <StrictMode>{table}</StrictMode> : table);
        });
      draw(false);
      expect(container.querySelector(".rk-table-scroll")).toBeNull();
      draw(true);
      const scroll = container.querySelector<HTMLDivElement>(".rk-table-scroll")!;
      expect(scroll.hasAttribute("data-fade-start")).toBe(false);
      expect(scroll.hasAttribute("data-fade-end")).toBe(true);
      act(() => {
        scroll.scrollLeft = 200;
        scroll.dispatchEvent(new Event("scroll"));
      });
      expect(scroll.hasAttribute("data-fade-start")).toBe(true);
      expect(scroll.hasAttribute("data-fade-end")).toBe(false);
      act(() => {
        scroll.scrollLeft = 50;
        observers.at(-1)!.update();
      });
      expect(scroll.hasAttribute("data-fade-end")).toBe(true);
    },
  );

  it("cleans up a removed table and observes its replacement", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
    const observers: { disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect = vi.fn();
        constructor() {
          observers.push(this);
        }
        observe() {}
      },
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    let unmounted = false;
    mounted.push(() => {
      if (!unmounted) act(() => root.unmount());
    });
    const draw = (visible: boolean) =>
      act(() => root.render(<Table columns={visible ? ["Name"] : []} />));
    draw(true);
    const old = container.querySelector<HTMLDivElement>(".rk-table-scroll")!;
    const remove = vi.spyOn(old, "removeEventListener");
    act(() => {
      old.scrollLeft = 200;
      old.dispatchEvent(new Event("scroll"));
    });
    draw(false);
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
    draw(true);
    const current = container.querySelector<HTMLDivElement>(".rk-table-scroll")!;
    expect(current).not.toBe(old);
    expect(current.hasAttribute("data-fade-start")).toBe(false);
    expect(current.hasAttribute("data-fade-end")).toBe(true);
    expect(observers).toHaveLength(2);
    act(() => {
      current.scrollLeft = 200;
      current.dispatchEvent(new Event("scroll"));
    });
    expect(current.hasAttribute("data-fade-start")).toBe(true);
    act(() => {
      old.scrollLeft = 0;
      old.dispatchEvent(new Event("scroll"));
    });
    expect(current.hasAttribute("data-fade-start")).toBe(true);
    act(() => root.unmount());
    unmounted = true;
    expect(observers[1]!.disconnect).toHaveBeenCalledOnce();
  });

  it("renders React node arrays in table cells like fragments", () => {
    const tags = ["Ready", "Reviewed"].map((tag) => <Status key={tag}>{tag}</Status>);
    const root = mount(
      <Table
        columns={["Tags"]}
        rows={[
          [tags],
          [<Fragment key="tags">{tags}</Fragment>],
          [["Count: ", 0, null, false, [<strong key="nested">Nested</strong>]]],
          [[]],
          [{ text: tags, tone: "success" }],
          ["Plain"],
          [42],
          [null],
        ]}
      />,
    );
    const cells = [...root.querySelectorAll("tbody td")];
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "ReadyReviewed",
      "ReadyReviewed",
      "Count: 0Nested",
      "",
      "ReadyReviewed",
      "Plain",
      "42",
      "",
    ]);
    expect(cells[0]!.innerHTML).toBe(cells[1]!.innerHTML);
    expect(cells[2]!.querySelector("strong")?.textContent).toBe("Nested");
  });

  it("filters rows by labels rendered in array cells", () => {
    const root = mount(
      <Table
        columns={["Tags"]}
        rows={Array.from({ length: 16 }, (_, i) => [
          [<Status key="tag">{i === 0 ? "Ready" : "Pending"}</Status>],
        ])}
      />,
    );
    const filter = root.querySelector<HTMLInputElement>("input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(filter, "Ready");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...root.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      "Ready",
    ]);
  });

  it("filters nested formatting, fragments and toned cells by their full text", () => {
    const root = mount(
      <Table
        columns={["Location"]}
        rows={[
          [
            <strong key="north">
              North <em>Depot</em>
            </strong>,
          ],
          [
            <Fragment key="south">
              South{" "}
              <span>
                <em>Depot</em>
              </span>
            </Fragment>,
          ],
          [
            {
              text: (
                <strong>
                  West <em>Depot</em>
                </strong>
              ),
              tone: "success",
            },
          ],
          ...Array.from({ length: 13 }, (_, i) => [`Office ${i}`]),
        ]}
      />,
    );
    const filter = root.querySelector<HTMLInputElement>("input")!;
    const search = (value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(filter, value);
        filter.dispatchEvent(new Event("input", { bubbles: true }));
      });
    search("Depot");
    expect([...root.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      "North Depot",
      "South Depot",
      "West Depot",
    ]);
    search("North Depot");
    expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(root.querySelector("tbody td")?.textContent).toBe("North Depot");
    search("Office 12");
    expect(root.querySelector("tbody td")?.textContent).toBe("Office 12");
  });

  it("sorts nested formatted numbers by their complete value in both directions", () => {
    const root = mount(
      <Table
        sortable
        columns={["Amount"]}
        rows={[
          [
            <strong key="two">
              <em>2</em>
            </strong>,
          ],
          [
            <Fragment key="hundred">
              1<span>00</span>
            </Fragment>,
          ],
          [
            {
              text: (
                <strong>
                  1<em>2</em>
                </strong>
              ),
              tone: "success",
            },
          ],
          [3],
          [
            <span key="zero">
              {null}
              {false}
              {0}
            </span>,
          ],
        ]}
      />,
    );
    const values = () => [...root.querySelectorAll("tbody td")].map((cell) => cell.textContent);
    const button = root.querySelector<HTMLButtonElement>("th button")!;
    act(() => button.click());
    expect(values()).toEqual(["0", "2", "3", "12", "100"]);
    act(() => button.click());
    expect(values()).toEqual(["100", "12", "3", "2", "0"]);
    act(() => button.click());
    expect(values()).toEqual(["2", "100", "12", "3", "0"]);
  });

  it("sorts figures as numbers, filters long tables and pages very long ones", () => {
    const root = mount(
      <Table
        sortable
        columns={["Account", "MRR"]}
        rows={[
          ["Acme", "$1,200"],
          ["Globex", "$480"],
          ["Initech", "$12k"],
        ]}
      />,
    );
    const names = () =>
      [...root.querySelectorAll("tbody td:first-child")].map((td) => td.textContent);
    const header = root.querySelectorAll("th")[1]!;
    const press = () => act(() => header.querySelector("button")!.click());
    press();
    expect(names()).toEqual(["Globex", "Acme", "Initech"]);
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    press();
    expect(names()).toEqual(["Initech", "Acme", "Globex"]);
    press();
    expect(names()).toEqual(["Acme", "Globex", "Initech"]);
    expect(header.hasAttribute("aria-sort")).toBe(false);
    expect(root.querySelector("input")).toBeNull();

    // A column of figures and words reverses whole: words first when descending.
    const mixed = mount(
      <Table
        sortable
        columns={["Item", "Qty"]}
        rows={[
          ["A", "3"],
          ["B", "n/a"],
          ["C", "1"],
        ]}
      />,
    );
    const mixedNames = () =>
      [...mixed.querySelectorAll("tbody td:first-child")].map((td) => td.textContent);
    const qty = mixed.querySelectorAll("th")[1]!.querySelector("button")!;
    act(() => qty.click());
    expect(mixedNames()).toEqual(["C", "A", "B"]);
    act(() => qty.click());
    expect(mixedNames()).toEqual(["B", "A", "C"]);

    const many = Array.from({ length: 450 }, (_, i) => [`Row ${i + 1}`, String(i)]);
    const long = mount(<Table columns={["Name", "N"]} rows={many} />);
    expect(long.querySelectorAll("tbody tr")).toHaveLength(200);
    expect(long.querySelector(".rk-table-more")!.textContent).toContain("Showing 200 of 450");
    act(() => long.querySelector<HTMLButtonElement>(".rk-table-more button")!.click());
    expect(long.querySelectorAll("tbody tr")).toHaveLength(400);
    const filter = long.querySelector<HTMLInputElement>("input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(filter, "Row 44");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...long.querySelectorAll("tbody td:first-child")].map((td) => td.textContent)).toEqual([
      "Row 44",
      "Row 440",
      "Row 441",
      "Row 442",
      "Row 443",
      "Row 444",
      "Row 445",
      "Row 446",
      "Row 447",
      "Row 448",
      "Row 449",
    ]);
    expect(long.querySelector(".rk-table-more")).toBeNull();
  });

  it("keeps a typed filter, and its no-match message, when the rows shrink below the filter size", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const draw = (n: number) =>
      act(() =>
        root.render(
          <Table columns={["Name"]} rows={Array.from({ length: n }, (_, i) => [`Alpha ${i}`])} />,
        ),
      );
    const type = (input: HTMLInputElement, text: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          text,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    draw(16);
    type(container.querySelector("input")!, "missing");
    draw(10);
    const retained = container.querySelector("input");
    expect(retained).not.toBeNull();
    expect(container.textContent).toContain("No rows match.");
    type(retained!, "");
    expect(container.textContent).toContain("Alpha 0");
    act(() => root.unmount());
  });
});
