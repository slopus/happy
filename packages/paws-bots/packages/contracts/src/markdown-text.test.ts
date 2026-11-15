import { describe, expect, it } from "vitest";
import { droppedTableHtmlText } from "./markdown-text.js";

describe("droppedTableHtmlText", () => {
  it.each([
    ['<img alt="Chart" data-alt="Decorative">', "Chart"],
    ['<img data-alt="Decorative" alt="Chart">', "Chart"],
    ['<img title="1 > 0" alt="Chart">', "Chart"],
    ["<img title='1 > 0' alt='Chart'>", "Chart"],
    ['<img alt="Chart" title="alt=Decorative">', "Chart"],
    ['<img title="alt=Decorative" alt="Chart">', "Chart"],
    ['<img alt="Chart alt=Decorative">', "Chart alt=Decorative"],
    ['<img alt="1 > 0">', "1 > 0"],
    ["<IMG SRC=x ALT = 'Chart &amp; graph' />", "Chart & graph"],
    ["<img alt=Chart>", "Chart"],
    ['<img alt="">', ""],
    ['<img alt="First" alt="Second">', "First"],
    ['<img alt="&lt; &#67; &#x1f600; &quot; &apos; &nbsp;">', "< C 😀 \" ' \u00a0"],
    ['<img data-alt="Decorative">', null],
    ['<img title="alt=Decorative">', null],
    ['<img><span alt="Decorative">', null],
    ['<img-custom alt="Decorative">', null],
    ['<span alt="Decorative">', null],
    ["<br>", " "],
    ["<BR />", " "],
  ])("extracts text from %s", (html, expected) => {
    expect(droppedTableHtmlText(html)).toBe(expected);
  });

  it("handles long whitespace between attributes and the tag end", () => {
    const spaces = " ".repeat(100_000);
    expect(droppedTableHtmlText(`<img${spaces}>`)).toBeNull();
    expect(droppedTableHtmlText(`<img${spaces}/>`)).toBeNull();
    expect(droppedTableHtmlText(`<img${spaces}alt="Chart"${spaces}>`)).toBe("Chart");
  });
});
