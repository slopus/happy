import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/chart-export.html";

for (const width of [640, 320, 160, 64]) {
  test(`exported legend fits a ${width}px canvas`, async ({ page }, testInfo) => {
    const long = width !== 640;
    await page.goto(`${fixture}?width=${width}${long ? "&long" : ""}`);
    const svg = page.locator("body > svg");
    await expect(svg).toBeVisible();
    const layout = await svg.evaluate((element) => {
      const plot = element.querySelector("svg")!;
      const labels = Array.from(element.children).filter((child) => child.tagName === "text");
      const swatches = Array.from(element.children).filter((child) => child.tagName === "rect");
      return {
        width: Number(element.getAttribute("width")),
        height: Number(element.getAttribute("height")),
        plotY: Number(plot.getAttribute("y")),
        plotHeight: Number(plot.getAttribute("height")),
        labels: labels.map((label) => {
          const box = (label as SVGGraphicsElement).getBBox();
          return {
            text: label.textContent,
            x: box.x,
            right: box.x + box.width,
            bottom: box.y + box.height,
          };
        }),
        rows: new Set(swatches.map((swatch) => swatch.getAttribute("y"))).size,
      };
    });
    expect(layout.width).toBe(width);
    expect(layout.rows).toBeGreaterThan(1);
    expect(layout.height).toBe(layout.plotY + layout.plotHeight);
    expect(layout.labels).toHaveLength(long ? 5 : 11);
    for (const label of layout.labels) {
      expect(label.x).toBeGreaterThanOrEqual(8);
      expect(label.right, label.text ?? "legend label").toBeLessThanOrEqual(width - 8);
      expect(label.bottom).toBeLessThan(layout.plotY);
    }
    const text = layout.labels.map((label) => label.text);
    if (long) {
      expect(text).toContain("W".repeat(80));
      expect(text).toContain("类别😀".repeat(16));
      expect(text).toContain('<&" export');
    } else {
      for (let i = 1; i <= 10; i++) expect(text).toContain(`Category ${i}`);
    }
    await captureScreenshot(page, testInfo, `exported-legend-${width}px`);
  });
}

for (const width of [160, 40]) {
  test(`exported graphemes keep natural proportions at ${width}px`, async ({ page }, testInfo) => {
    await page.goto(`${fixture}?width=${width}&long&graphemes`);
    const svg = page.locator("body > svg");
    await expect(svg).toBeVisible();
    const labels = await svg.evaluate((element) =>
      Array.from(element.children)
        .filter((child) => child.tagName === "text")
        .map((label) => ({
          text: label.textContent,
          lines: Array.from(label.children).map((child) => {
            const line = child as SVGTSpanElement;
            const reference = document.createElementNS("http://www.w3.org/2000/svg", "text");
            reference.setAttribute("font-family", label.getAttribute("font-family")!);
            reference.setAttribute("font-size", "12");
            reference.textContent = line.textContent;
            element.append(reference);
            const naturalWidth = reference.getBBox().width;
            reference.remove();
            const box = line.getBBox();
            return {
              text: line.textContent,
              width: box.width,
              right: box.x + box.width,
              naturalWidth,
              fontSize: Number.parseFloat(getComputedStyle(line).fontSize),
            };
          }),
        })),
    );
    await captureScreenshot(page, testInfo, `exported-graphemes-${width}px`);
    expect(labels.map((label) => label.text)).toEqual(
      expect.arrayContaining(["👨‍👩‍👧‍👦", "🇨🇦", "👍🏽", "1️⃣", "é", "👨‍👩‍👧‍👦".repeat(20)]),
    );
    for (const label of labels) {
      for (const line of label.lines) {
        expect(line.width, line.text ?? "grapheme").toBeLessThanOrEqual(line.naturalWidth + 0.1);
        expect(line.right).toBeLessThanOrEqual(width - 8);
        expect(line.fontSize).toBeLessThanOrEqual(12);
        if (width === 160) expect(line.fontSize).toBe(12);
      }
    }
  });
}
