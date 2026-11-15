import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/markdown-table.html";
const longValue =
  "This deliberately long table value contains enough words to wrap completely inside the expanded dialog without clipping or ellipsis.";

function tableMarkdown(rowCount: number, columns = ["Item", "Qty"]) {
  const rows = Array.from(
    { length: rowCount },
    (_, i) => `| item-${String(i + 1).padStart(2, "0")} | ${(i * 7) % 13} |`,
  );
  return [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows,
  ].join("\n");
}

test("markdown tables render as an interactive card", async ({ page }, testInfo) => {
  await page.goto(fixture);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const card = page.getByTestId("table-card");
  await expect(card).toBeVisible();
  await expect(card.locator("tbody tr")).toHaveCount(10);
  await expect(card.getByRole("button", { name: "Copy rows" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Download CSV" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Expand table" })).toBeVisible();

  const toolbar = card.locator(":scope > .rk-table-head");
  const headers = card.locator("thead");
  await expect(toolbar).toHaveCSS("position", "static");
  const toolbarBox = await toolbar.boundingBox();
  const headerBox = await headers.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(headerBox!.y + 1);

  // Numeric sort: desc puts qty 12 first; lexicographic would put 9 first.
  // thead th nth(0) is the row-number gutter, so Qty sits at index 2.
  const qtyHeader = card.locator("thead th").nth(2);
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  await expect(qtyHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(card.locator("tbody tr").first()).toContainText("item-01");
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  await expect(qtyHeader).toHaveAttribute("aria-sort", "descending");
  await expect(card.locator("tbody tr").first()).toContainText("item-12");
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  await expect(qtyHeader).not.toHaveAttribute("aria-sort", /./);
  await expect(card.locator("tbody tr").first()).toContainText("item-01");

  await expect(card.getByText("1–10 of 12 rows")).toBeVisible();
  await card.getByRole("button", { name: "Next page" }).click();
  await expect(card.getByText("11–12 of 12 rows")).toBeVisible();
  await expect(card.locator("tbody tr")).toHaveCount(2);
  await card.getByRole("button", { name: "Previous page" }).click();
  await expect(card.locator("tbody tr")).toHaveCount(10);

  // Copy and download the complete sorted data, not only the visible page.
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  const sorted = Array.from({ length: 12 }, (_, i) => ({
    item: `item-${String(i + 1).padStart(2, "0")}`,
    qty: (i * 7) % 13,
  })).sort((a, b) => b.qty - a.qty);
  const expectedTsv = ["Item\tQty", ...sorted.map(({ item, qty }) => `${item}\t${qty}`)].join("\n");
  await card.getByRole("button", { name: "Copy rows" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(expectedTsv);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    card.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("table.csv");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const expectedCsv = ["Item,Qty", ...sorted.map(({ item, qty }) => `${item},${qty}`)].join("\n");
  expect(await readFile(downloadPath!, "utf8")).toBe(`\uFEFF${expectedCsv}`);

  await card.getByRole("button", { name: "Expand table" }).click();
  const dialog = page.getByRole("dialog", { name: "Table" });
  await expect(dialog.locator("tbody tr")).toHaveCount(10);
  // Focus moves to the close control, and cells keep their card styling even
  // though the Base UI dialog portal sits outside .rk-chat-markdown.
  await expect(dialog.getByRole("button", { name: "Close table" })).toBeFocused();
  const cellPadding = await dialog
    .locator("tbody td")
    .nth(1)
    .evaluate((el) => getComputedStyle(el).padding);
  expect(cellPadding).not.toBe("0px");
  await captureScreenshot(page, testInfo, "markdown-table-card");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Expand table" })).toBeFocused();
});

test("rich table links participate in dialog keyboard navigation", async ({ page }) => {
  await page.goto(`${fixture}?rich=1`);
  const card = page.getByTestId("table-card");
  await expect(card.locator("thead .rk-table-sort-label a")).toHaveAttribute(
    "href",
    "https://example.test/ref",
  );
  await expect(card.locator("thead .rk-table-sort-label strong")).toHaveText("Note");
  const referenceHeader = card.locator("thead th").nth(1);
  await expect(referenceHeader).not.toHaveAttribute("aria-sort", /./);
  const headerLink = card.locator("thead .rk-table-sort-label a");
  await headerLink.evaluate((element) => {
    element.addEventListener("click", (event) => event.preventDefault(), { capture: true });
  });
  await headerLink.click();
  const confirm = page.getByRole("alertdialog", { name: "Open external link?" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("https://example.test/ref");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(referenceHeader).not.toHaveAttribute("aria-sort", /./);
  await card.getByRole("button", { name: "Sort by Reference" }).click();
  await expect(referenceHeader).toHaveAttribute("aria-sort", "ascending");
  const inlineLink = card.getByRole("link", { name: "Docs" });
  await expect(inlineLink).toHaveAttribute("href", "https://example.test/docs");
  await expect(inlineLink).toHaveAttribute("target", "_blank");
  await expect(inlineLink).toHaveAttribute("rel", "noreferrer noopener");

  await card.getByRole("button", { name: "Expand table" }).click();
  const dialog = page.getByRole("dialog", { name: "Table" });
  const dialogLink = dialog.getByRole("link", { name: "Docs" });
  await expect(dialog.locator("code")).toHaveCSS("border-top-style", "solid");
  await dialogLink.focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Copy rows" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialogLink).toBeFocused();
});

test("rich table cells stay associated through sorting and pagination", async ({ page }) => {
  await page.goto(`${fixture}?rich-many=1&stream=1`);
  const card = page.getByTestId("table-card");
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  const focusedLink = card.getByRole("link", { name: "Docs 02" });
  await focusedLink.focus();
  await page.evaluate(
    (markdown) => {
      window.dispatchEvent(new CustomEvent("rk-table-stream-update", { detail: { markdown } }));
    },
    [
      "| Reference | Qty |",
      "| --- | --- |",
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `| [Docs ${String(i + 1).padStart(2, "0")}](https://example.test/docs/${i + 1}) | ${i === 3 ? 6 : (i * 7) % 13} |`,
      ),
    ].join("\n"),
  );
  await expect(focusedLink).toBeFocused();
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  await expect(
    card.locator("tbody tr").first().getByRole("link", { name: "Docs 12" }),
  ).toHaveAttribute("href", "https://example.test/docs/12");

  await card.getByRole("button", { name: "Next page" }).click();
  await expect(card.getByRole("link", { name: "Docs 03" })).toHaveAttribute(
    "href",
    "https://example.test/docs/3",
  );
});

test("expanded tables show long cell content without truncation", async ({ page }, testInfo) => {
  await page.goto(`${fixture}?long=1`);
  const card = page.getByTestId("table-card");
  const inlineCell = card.locator(".rk-table-cell-text").filter({ hasText: longValue });
  const inlineMetrics = await inlineCell.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
  expect(inlineMetrics.whiteSpace).toBe("nowrap");
  expect(inlineMetrics.textOverflow).toBe("ellipsis");
  expect(inlineMetrics.scrollWidth).toBeGreaterThan(inlineMetrics.clientWidth);

  await card.getByRole("button", { name: "Expand table" }).click();
  const dialogCell = page
    .getByRole("dialog", { name: "Table" })
    .locator(".rk-table-cell-text")
    .filter({ hasText: longValue });
  const dialogMetrics = await dialogCell.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
  expect(dialogMetrics.whiteSpace).toBe("normal");
  expect(dialogMetrics.overflow).toBe("visible");
  expect(dialogMetrics.textOverflow).toBe("clip");
  expect(dialogMetrics.scrollHeight - dialogMetrics.clientHeight).toBeLessThanOrEqual(1);
  expect(dialogMetrics.scrollWidth - dialogMetrics.clientWidth).toBeLessThanOrEqual(1);

  // The dialog sizes to content: a two-column table hugs its ~32rem floor.
  const box = await page.getByRole("dialog", { name: "Table" }).boundingBox();
  const viewportWidth = page.viewportSize()?.width ?? 1280;
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThan(viewportWidth * 0.6);
  await captureScreenshot(page, testInfo, "table-dialog-width");
});

test("nested table dialogs close independently", async ({ page }) => {
  await page.goto(`${fixture}?nested=1&rich=1`);
  const outerDialog = page.getByRole("dialog", { name: "Outer preview" });
  await expect(outerDialog).toBeVisible();

  const expand = outerDialog.getByRole("button", { name: "Expand table" });
  await expand.click();
  const tableDialog = page.getByRole("dialog", { name: "Table" });
  await expect(tableDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tableDialog).toHaveCount(0);
  await expect(outerDialog).toBeVisible();
  await expect(expand).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(outerDialog).toHaveCount(0);
});

test("backdrop dismissal restores focus and page scroll", async ({ page }) => {
  await page.goto(`${fixture}?tall=1`);
  const card = page.getByTestId("table-card");
  await card.scrollIntoViewIfNeeded();
  const scrollY = await page.evaluate(() => window.scrollY);

  const expand = card.getByRole("button", { name: "Expand table" });
  await expand.click();
  await expect(page.getByRole("dialog", { name: "Table" })).toBeVisible();
  await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 2, y: 2 } });
  await expect(page.getByRole("dialog", { name: "Table" })).toHaveCount(0);
  await expect(expand).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollY);
});

test("streaming rows preserve state while schema changes reset it", async ({ page }) => {
  await page.goto(`${fixture}?stream=1`);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const card = page.getByTestId("table-card");
  await card.getByRole("button", { name: "Sort by Qty" }).click();
  await card.getByRole("button", { name: "Next page" }).click();
  await card.getByRole("button", { name: "Copy rows" }).click();
  await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
  await card.getByRole("button", { name: "Expand table" }).click();

  await page.evaluate(
    (markdown) => {
      window.dispatchEvent(new CustomEvent("rk-table-stream-update", { detail: { markdown } }));
    },
    `Results updated.\n\n${tableMarkdown(13).replace("| item-01 | 0 |", "| item-updated | 99 |")}`,
  );

  const dialog = page.getByRole("dialog", { name: "Table" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("columnheader", { name: /Qty/ })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await expect(dialog.getByText("11–13 of 13 rows")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy rows" })).toBeVisible();
  await expect(dialog).toContainText("item-updated");

  await page.evaluate(
    (markdown) => {
      window.dispatchEvent(new CustomEvent("rk-table-stream-update", { detail: { markdown } }));
    },
    tableMarkdown(13, ["Name", "Score"]),
  );

  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Expand table" })).toBeFocused();
  await expect(card.getByRole("columnheader", { name: /Score/ })).not.toHaveAttribute(
    "aria-sort",
    /./,
  );
  await expect(card.getByText("1–10 of 13 rows")).toBeVisible();
});

test("small tables skip pagination", async ({ page }) => {
  await page.goto(`${fixture}?rows=3`);
  const card = page.getByTestId("table-card");
  await expect(card).toBeVisible();
  await expect(card.locator("tbody tr")).toHaveCount(3);
  await expect(card.getByText("3 rows")).toBeVisible();
  await expect(card.getByRole("button", { name: "Next page" })).toHaveCount(0);
});

test("table chrome follows right-to-left direction", async ({ page }) => {
  // Production bubbles carry dir="auto", never dir="rtl" — the sort control
  // flip must key off the resolved direction (:dir), not an ancestor attribute.
  await page.goto(`${fixture}?rtl=1`);
  const rtlCard = page.getByTestId("table-card");
  await expect(rtlCard).toBeVisible();
  await expect(rtlCard.locator(".rk-align-right .rk-table-sort")).toHaveCSS(
    "flex-direction",
    "row",
  );

  await page.goto(fixture);
  const card = page.getByTestId("table-card");
  await expect(card.locator(".rk-align-right .rk-table-sort")).toHaveCSS(
    "flex-direction",
    "row-reverse",
  );

  await page.locator("html").evaluate((element) => element.setAttribute("dir", "rtl"));
  const gutter = card.locator("tbody .rk-table-gutter").first();
  await expect(gutter).toHaveCSS("border-left-width", "1px");
  await expect(gutter).toHaveCSS("border-right-width", "0px");

  const qtyHeader = card.locator("thead th").nth(2);
  const labelBox = await qtyHeader.locator(".rk-table-sort-label").boundingBox();
  const iconBox = await qtyHeader.locator(".rk-table-sort-icon").boundingBox();
  expect(labelBox).not.toBeNull();
  expect(iconBox).not.toBeNull();
  expect(labelBox!.x).toBeGreaterThan(iconBox!.x);
});

test("wide tables scroll inside a focusable card region", async ({ page }) => {
  await page.goto(`${fixture}?wide=1`);
  const card = page.getByTestId("table-card");
  const scroll = card.locator(":scope > .rk-table-scroll");
  await expect(scroll).toBeVisible();

  const metrics = await scroll.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    tabIndex: element.tabIndex,
  }));
  // The overflow lives on the region, not the <table> element.
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  // Focusable so keyboard users can scroll the region.
  expect(metrics.tabIndex).toBe(0);
  await scroll.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => scroll.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
});

test("sorting announces the new order and disambiguates header labels", async ({ page }) => {
  await page.goto(`${fixture}?dup-cols=1`);
  const card = page.getByTestId("table-card");
  await expect(card.getByRole("button", { name: "Sort by column 1" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Sort by Qty, column 2" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Sort by Qty, column 3" })).toBeVisible();

  await card.getByRole("button", { name: "Sort by Qty, column 2" }).click();
  await expect(card.getByRole("status")).toHaveText("Sorted by Qty, column 2, ascending");
});

test("paging announces the visible range", async ({ page }) => {
  await page.goto(`${fixture}?rows=25`);
  const card = page.getByTestId("table-card");
  await card.getByRole("button", { name: "Next page" }).click();
  await expect(card.getByRole("status")).toHaveText("Page 2 of 3");
});

test.describe("touch table controls", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("toolbar controls are visible, large enough, and do not cover the table", async ({
    page,
  }) => {
    await page.goto(fixture);
    const card = page.getByTestId("table-card");
    const toolbar = card.locator(":scope > .rk-table-head");
    const scroll = card.locator(":scope > .rk-table-scroll");
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toHaveCSS("position", "static");

    const toolbarBox = await toolbar.boundingBox();
    const scrollBox = await scroll.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(scrollBox).not.toBeNull();
    expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(scrollBox!.y + 1);

    for (const name of ["Copy rows", "Download CSV", "Expand table"]) {
      const box = await card.getByRole("button", { name }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    const sortBox = await card.getByRole("button", { name: "Sort by Item" }).boundingBox();
    expect(sortBox).not.toBeNull();
    expect(sortBox!.height).toBeGreaterThanOrEqual(44);

    await card.getByRole("button", { name: "Expand table" }).click();
    const dialog = page.getByRole("dialog", { name: "Table" });
    for (const name of ["Copy rows", "Download CSV", "Close table"]) {
      const button = dialog.getByRole("button", { name });
      await expect
        .poll(async () => (await button.boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(44);
      await expect
        .poll(async () => (await button.boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(44);
    }
  });
});

test("failed table copy offers selected text", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    document.execCommand = () => false;
  });
  await page.goto(fixture);
  await page.getByRole("button", { name: "Copy rows" }).click();
  const dialog = page.getByRole("dialog", { name: "Copy rows" });
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole("textbox");
  await expect(field).toHaveValue(/Item\tQty\nitem-01/);
  await expect(field).toBeFocused();
  expect(await field.evaluate((element: HTMLTextAreaElement) => element.selectionEnd)).toBe(
    (await field.inputValue()).length,
  );
  await captureScreenshot(page, testInfo, "table-copy-fallback");
});
