// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pageKitPalette } from "@rakazo/ui-tokens";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Columns } from "./dataviz.js";
import { inlineMarkup } from "./inline.js";
import { Page, Section, Text } from "./layout.js";
import "./index.js";
import {
  BulletList,
  Equation,
  Frac,
  Legend,
  LinkCards,
  NumberedList,
  PageHero,
  PageMeta,
  ProsCons,
  Quote,
  Sum,
  TableOfContents,
} from "./text.js";
import { computeDAGLayout, useSource, useTheme } from "./theme.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = (element: ReactElement) => renderToStaticMarkup(element);

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.documentElement.removeAttribute("data-theme");
});

function mount(element: ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(element));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

describe("lists", () => {
  it("nests items, numbers each level in its own style and drops junk", () => {
    const markup = html(
      <NumberedList
        items={[
          "Collect",
          { text: "Clean", items: ["Dedupe", { text: "Dates", items: ["UTC"] }] },
          null as never,
          "Ship **it**",
        ]}
      />,
    );
    const numbers = [...markup.matchAll(/rk-li-number" dir="ltr">([^<]+)</g)].map((m) => m[1]);
    expect(numbers).toEqual(["1.", "2.", "a.", "b.", "i.", "3."]);
    expect(markup).toContain("Ship <strong>it</strong>");
  });

  it("marks top-level bullets solid and nested ones hollow, and renders nothing when empty", () => {
    const markup = html(<BulletList items={["a", { text: "b", bullets: ["c"] }]} />);
    expect(markup.match(/fill="currentColor"/g)).toHaveLength(2);
    expect(markup.match(/fill="none" stroke="currentColor"/g)).toHaveLength(1);
    expect(html(<BulletList items={[]} />)).toBe("");
    expect(html(<BulletList items={"oops" as never} />)).toBe("");
  });

  it("shows pros and cons with their own headings and skips an empty side", () => {
    const markup = html(
      <ProsCons pros={["Fast"]} cons={[]} prosHeading="Wins" consHeading="Risks" />,
    );
    expect(markup).toContain("Wins");
    expect(markup).not.toContain("Risks");
    expect(markup).toContain('data-marker="pro"');
    expect(html(<ProsCons />)).toBe("");
  });
});

describe("text", () => {
  it("reads underscore emphasis and www links, but leaves snake_case alone", () => {
    const markup = html(
      <Text>{"an _important_ note at www.example.org/a, see snake_case_name"}</Text>,
    );
    expect(markup).toContain("<em>important</em>");
    expect(markup).toContain('href="https://www.example.org/a"');
    expect(markup).toContain("snake_case_name");
    expect(markup).not.toContain("<em>case</em>");
  });

  it("attributes a quote and renders nothing without words", () => {
    const markup = html(<Quote cite="Ana, support lead">Exports are **fast** now</Quote>);
    expect(markup).toMatch(
      /<blockquote[^>]*>.*Exports are <strong>fast<\/strong> now.*Ana, support lead/,
    );
    expect(html(<Quote cite="x" />)).toBe("");
  });
});

describe("structure", () => {
  it("places a leading hero above the title and anchors sections by id or heading", () => {
    const markup = html(
      <Page title="Report">
        <PageHero eyebrow="Field notes">art</PageHero>
        <PageMeta>By Ana</PageMeta>
        <Section heading="Bottom line?">x</Section>
        <Section heading="Costs" id="money">
          y
        </Section>
      </Page>,
    );
    expect(markup.indexOf("art")).toBeLessThan(markup.indexOf("Field notes"));
    expect(markup.indexOf("Field notes")).toBeLessThan(markup.indexOf("<h1"));
    expect(markup.indexOf("By Ana")).toBeLessThan(markup.indexOf("</header>"));
    expect(markup).toContain('id="bottom-line"');
    expect(markup).toContain('id="money"');
  });

  it("takes the page's own chart colours and language, ignoring anything that is not a colour", () => {
    const markup = html(
      <Page title="t" lang="ja" palette={["#ff9800", "url(x)", "rgb(1, 2, 3)"]}>
        x
      </Page>,
    );
    expect(markup).toContain('lang="ja"');
    expect(markup).toContain("--rk-c1:#ff9800");
    expect(markup).toContain("--rk-c3:rgb(1, 2, 3)");
    expect(markup).not.toContain("url(x)");
  });

  it("puts a caption under the first figure, or under the first block when there is none", () => {
    const withFigure = html(
      <Section heading="Mix" caption="Share of revenue">
        <Text>intro</Text>
        <ProsCons pros={["a"]} />
        <Text>after</Text>
      </Section>,
    );
    expect(withFigure.indexOf("Share of revenue")).toBeGreaterThan(
      withFigure.indexOf("rk-proscons"),
    );
    expect(withFigure.indexOf("Share of revenue")).toBeLessThan(withFigure.indexOf("after"));
    const chart = html(
      <Section heading="Orders" caption="Per week">
        <Text>intro</Text>
        <Columns points={[{ label: "W1", value: 3 }]} />
      </Section>,
    );
    expect(chart.indexOf("Per week")).toBeGreaterThan(chart.indexOf("intro"));
    const plain = html(
      <Section heading="Notes" caption="Read first">
        <Text>filters</Text>
        <Text>board</Text>
      </Section>,
    );
    expect(plain.indexOf("Read first")).toBeGreaterThan(plain.indexOf("filters"));
    expect(plain.indexOf("Read first")).toBeLessThan(plain.indexOf("board"));
  });

  it("allows keyboard clicks with selected text while preserving pointer selection protection", () => {
    const host = mount(
      <Page title="t">
        <Text>Select this text</Text>
        <Section heading="Details" collapsible>
          <Text>hidden body</Text>
        </Section>
      </Page>,
    );
    const toggle = host.querySelector<HTMLButtonElement>(".rk-section-toggle")!;
    const fold = host.querySelector(".rk-section-fold")!;
    toggle.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(host.querySelector("p")!);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      expect(selection.toString()).toBe("Select this text");
      // Native Enter/Space activation dispatches a click with detail zero.
      act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(fold.hasAttribute("inert")).toBe(false);
      act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(fold.hasAttribute("inert")).toBe(true);

      range.selectNodeContents(toggle.querySelector("span")!);
      selection.removeAllRanges();
      selection.addRange(range);
      act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      selection.removeAllRanges();
      act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    } finally {
      selection.removeAllRanges();
    }
  });

  it("folds a collapsible section from its heading button and starts open only on request", () => {
    const host = mount(
      <Page title="t">
        <Section heading="Details" collapsible>
          <Text>hidden body</Text>
        </Section>
        <Section heading="Open" collapsible defaultOpen>
          <Text>shown body</Text>
        </Section>
      </Page>,
    );
    const [closed, open] = [...host.querySelectorAll<HTMLButtonElement>(".rk-section-toggle")];
    expect(closed!.getAttribute("aria-expanded")).toBe("false");
    expect(open!.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".rk-section-fold:not([data-open])")?.hasAttribute("inert")).toBe(
      true,
    );
    act(() => closed!.click());
    expect(closed!.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll(".rk-section-fold[inert]")).toHaveLength(0);
    // A plain section has no toggle.
    expect(html(<Section heading="Plain">x</Section>)).not.toContain("rk-section-toggle");
  });
});

describe("TableOfContents", () => {
  const items = Array.from({ length: 16 }, (_, index) => ({
    label: `Part ${index + 1}`,
    id: `p${index + 1}`,
    depth: index % 5 === 4 ? 1 : 0,
  }));

  it("folds a long list behind Show all and unfolds it", () => {
    const host = mount(<TableOfContents items={items} />);
    expect(host.querySelectorAll("nav > a")).toHaveLength(12);
    const fold = host.querySelector<HTMLButtonElement>(".rk-toc-fold")!;
    expect(fold.textContent).toBe("Show all 16");
    act(() => fold.click());
    expect(host.querySelectorAll("nav > a")).toHaveLength(16);
    expect(fold.textContent).toBe("Show fewer");
  });

  it("keeps a list that would hide only a few entries unfolded", () => {
    const markup = html(<TableOfContents items={items.slice(0, 15)} />);
    expect(markup).not.toContain("rk-toc-fold");
    expect(markup.match(/<a /g)).toHaveLength(15);
  });

  it("marks the first entry current, indents by depth and scrolls on click", () => {
    const target = document.body.appendChild(document.createElement("section"));
    target.id = "p2";
    target.scrollIntoView = vi.fn();
    const host = mount(<TableOfContents items={items.slice(0, 5)} title="Contents" />);
    expect(host.querySelector("nav")!.getAttribute("aria-label")).toBe("Contents");
    expect(host.querySelector('a[aria-current="location"]')!.textContent).toBe("Part 1");
    expect(host.querySelector<HTMLAnchorElement>('a[href="#p5"]')!.style.paddingLeft).toBe("22px");
    act(() => host.querySelector<HTMLAnchorElement>('a[href="#p2"]')!.click());
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
    target.remove();
    expect(html(<TableOfContents items={[]} />)).toBe("");
  });

  it("falls back to the first entry when the headings change", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    for (const list of [[], items.slice(0, 2), items.slice(2, 4)]) {
      act(() => root.render(<TableOfContents items={list} />));
      if (!list.length) continue;
      expect(host.querySelector('a[aria-current="location"]')!.textContent).toBe(list[0]!.label);
      expect(host.querySelector(".rk-toc-compact-current")!.textContent).toBe(list[0]!.label);
    }
    act(() => root.unmount());
    host.remove();
  });
});

describe("links and legend", () => {
  it("numbers link cards, labels the site from the address and leaves bad links inert", () => {
    const markup = html(
      <LinkCards
        numbered
        links={[
          { title: "Report", href: "https://www.example.com/r", date: "2026-10-01" },
          { title: "Script", href: "javascript:alert(1)" },
        ]}
      />,
    );
    expect(markup).toContain("example.com · 2026-10-01");
    expect(markup).toContain('href="https://www.example.com/r"');
    expect(markup).not.toContain("javascript:");
    expect(markup.match(/rk-linkcard-badge" aria-hidden="true">(\d)/g)).toHaveLength(2);
  });

  it("opens link cards through the host", () => {
    const post = vi.spyOn(window.parent, "postMessage");
    const host = mount(<LinkCards links={[{ title: "Docs", href: "https://example.com/docs" }]} />);
    act(() => host.querySelector("a")!.click());
    expect(post).toHaveBeenCalledWith(
      { type: "rakazo-page:open-link", url: "https://example.com/docs" },
      "*",
    );
    post.mockRestore();
  });

  it("draws the names comparison points at as grey dashed lines, in their place", () => {
    const markup = html(
      <Legend names={["Daily visits", "7-day average", "Signups"]} comparison={[1]} />,
    );
    const items = markup.match(/<li [\s\S]*?<\/li>/g)!;
    expect(items.map((item) => item.replace(/<[^>]+>/g, ""))).toEqual([
      "Daily visits",
      "7-day average",
      "Signups",
    ]);
    expect(items.map((item) => item.includes('stroke-dasharray="3 2"'))).toEqual([
      false,
      true,
      false,
    ]);
    expect(items[1]).toContain("color:var(--rk-other)");
    expect(items[2]).toContain("color:var(--rk-c3)");
    expect(html(<Legend names={[]} />)).toBe("");
  });
});

describe("math", () => {
  it("lays out terms, fractions and sums with an accessible label", () => {
    const markup = html(
      <Equation label="Break-even">
        Sales = <Frac num="fixed" den="margin" /> + <Sum from="i=1" to="n" />
      </Equation>,
    );
    expect(markup).toContain('role="math" aria-label="Break-even"');
    expect(markup).toContain("<span>Sales =</span>");
    expect(markup).toMatch(
      /<span>fixed<\/span><span class="rk-frac-bar"[^>]*><\/span><span>margin<\/span>/,
    );
    expect(markup).toContain("∑");
    expect(html(<Equation />)).toBe("");
  });
});

describe("helpers", () => {
  function Probe() {
    const theme = useTheme();
    return (
      <i data-kind={theme.kind} data-bg={theme.bg.base} data-c={theme.dataviz.categorical[0]} />
    );
  }

  it("takes every colour from the shared page palette", () => {
    const root = join(import.meta.dirname, "..");
    const sources = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (file) => /\.tsx?$/.test(file) && !/\.(test|d)\.tsx?$/.test(file),
    );
    expect(sources).toContain("kit/theme.ts");
    const literal = /#[0-9a-f]{3,8}\b|\b(rgb|hsl)a?\(/i;
    expect(sources.filter((file) => literal.test(readFileSync(join(root, file), "utf8")))).toEqual(
      [],
    );
    let theme: ReturnType<typeof useTheme> | undefined;
    function Grab() {
      theme = useTheme();
      return null;
    }
    for (const kind of ["dark", "light"] as const) {
      document.documentElement.dataset.theme = kind;
      mount(<Grab />);
      const tone: Record<string, string> = pageKitPalette[kind];
      expect(theme?.text).toMatchObject({
        accentDeep: tone.accentDeep,
        successDeep: tone.successDeep,
        warningDeep: tone.warningDeep,
        dangerDeep: tone.dangerDeep,
      });
      expect(tone.accentDeep).toMatch(/^#/);
      expect(theme?.dataviz.diverging).toEqual([
        tone.div1,
        tone.div2,
        tone.div3,
        tone.div4,
        tone.div5,
      ]);
      expect(tone.div1).toMatch(/^#/);
    }
  });

  it("follows the page's theme", () => {
    document.documentElement.dataset.theme = "light";
    const host = mount(<Probe />);
    const probe = host.querySelector("i")!;
    expect(probe.dataset.kind).toBe("light");
    const lightBg = probe.dataset.bg;
    act(() => {
      document.documentElement.dataset.theme = "dark";
    });
    return Promise.resolve().then(() => {
      expect(probe.dataset.kind).toBe("dark");
      expect(probe.dataset.bg).not.toBe(lightBg);
    });
  });

  it("draws in light colours while printing, whatever the page's theme", () => {
    // Print turns the page's CSS light; hand-drawn colours must follow or ink lands on white.
    const listeners = new Set<() => void>();
    let printing = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query === "print" && printing;
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    document.documentElement.dataset.theme = "dark";
    const host = mount(<Probe />);
    const probe = host.querySelector("i")!;
    expect(probe.dataset.kind).toBe("dark");
    act(() => {
      printing = true;
      for (const listener of listeners) listener();
    });
    expect(probe.dataset.kind).toBe("light");
    act(() => {
      printing = false;
      for (const listener of listeners) listener();
    });
    expect(probe.dataset.kind).toBe("dark");
    vi.unstubAllGlobals();
  });

  it("returns declared source snapshots as not fresh and rejects unknown ids", () => {
    (globalThis as { __rakazoPageSources?: unknown }).__rakazoPageSources = {
      sales: { snapshot: { total: 4 }, asOf: "2026-10-30T00:00:00Z" },
    };
    function Uses({ id }: { id: string }) {
      const source = useSource(id);
      return <i>{JSON.stringify(source)}</i>;
    }
    expect(html(<Uses id="sales" />)).toContain(
      JSON.stringify({
        value: { total: 4 },
        asOf: "2026-10-30T00:00:00Z",
        fresh: false,
        updating: false,
      }).replace(/"/g, "&quot;"),
    );
    expect(() => html(<Uses id="other" />)).toThrow(/no source with that id/);
    delete (globalThis as { __rakazoPageSources?: unknown }).__rakazoPageSources;
  });

  it("lays out a diagram for custom drawing", () => {
    const layout = computeDAGLayout(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      [{ from: "a", to: "b" }],
    );
    expect(JSON.stringify(layout)).toContain('"a"');
    expect(() => computeDAGLayout(null as never, null as never)).not.toThrow();
  });
});

describe("inline links", () => {
  it.each([
    [
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
    ],
    ["https://example.org/a_(b_(c))", "https://example.org/a_(b_(c))"],
    ["https://[2001:db8::1]", "https://[2001:db8::1]/"],
    ["https://example.org/items[0]", "https://example.org/items[0]"],
    ["https://example.org/a)b(c)", "https://example.org/a)b(c)"],
    ["www.example.org/a_(b)", "https://www.example.org/a_(b)"],
  ])("preserves paired URL delimiters in %s", (url, href) => {
    const host = mount(<Text>{`See (${url}).`}</Text>);
    const link = host.querySelector("a");
    expect(link?.getAttribute("href")).toBe(href);
    expect(link?.textContent).toBe(url);
    expect(host.textContent).toBe(`See (${url}).`);
  });

  it("leaves unmatched closing brackets and sentence punctuation outside links", () => {
    const host = mount(
      <Text>{"See [https://example.org/a_(b)]., and https://example.org/plain)."}</Text>,
    );
    expect([...host.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "https://example.org/a_(b)",
      "https://example.org/plain",
    ]);
  });

  it("opens the full paired URL through the host", () => {
    const url = "https://en.wikipedia.org/wiki/Rust_(programming_language)";
    const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
    try {
      const host = mount(<Text>{url}</Text>);
      act(() => host.querySelector("a")!.click());
      expect(postMessage).toHaveBeenCalledWith({ type: "rakazo-page:open-link", url }, "*");
    } finally {
      postMessage.mockRestore();
    }
  });

  it("trims a link's trailing punctuation in linear time, however long the run", () => {
    const html = (text: string) => renderToStaticMarkup(<span>{inlineMarkup(text)}</span>);
    expect(html("See https://example.com/a).")).toContain('href="https://example.com/a"');
    for (const input of [
      `https://a.co/${".".repeat(50_000)}x`,
      `https://a.co/${"]".repeat(50_000)}x`,
      `https://a.co/${".)".repeat(25_000)}x`,
    ]) {
      // Best of three, so a busy machine cannot fail it; the quadratic trim took seconds.
      const runs = [0, 1, 2].map(() => {
        const started = performance.now();
        inlineMarkup(input);
        return performance.now() - started;
      });
      expect(Math.min(...runs)).toBeLessThan(50);
    }
  });
});
