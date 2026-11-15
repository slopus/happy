import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Bars, LineChart, Pie } from "./charts.js";
import { Checklist, Metrics, Properties, Rows, Segmented, Status, Steps, Table } from "./data.js";
import { Diagram, layoutDiagram, wrapText } from "./diagram.js";
import { inlineMarkup } from "./inline.js";
import { Callout, Grid, Page, Section, Text } from "./layout.js";

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("page kit", () => {
  it("draws grid children as cards and steps headings down by depth", () => {
    const markup = html(
      <Page title="Launch tracker" summary="Updated **Monday**" width="wide">
        <Section
          heading="Headline"
          caption="As of Oct 31"
          actions={<Segmented options={["7d"]} value="7d" />}
        >
          x
        </Section>
        <Grid columns={9}>
          <Section heading="Status">
            <Section heading="Inner">y</Section>
          </Section>
          <Properties items={[{ label: "Owner", value: "Ana" }]} />
        </Grid>
      </Page>,
    );
    expect(markup).toContain('<p class="rk-summary">Updated <strong>Monday</strong></p>');
    expect(markup).toContain('data-width="wide"');
    expect(markup).toMatch(
      /<section class="rk-section" id="headline" data-headed="true"><div class="rk-section-head"><h2 class="rk-heading">Headline<\/h2><div class="rk-actions"><fieldset class="rk-segmented"/,
    );
    expect(markup).toContain('x<p class="rk-caption" data-figure="true">As of Oct 31</p>');
    expect(markup).toContain(
      'data-card="true" data-headed="true"><div class="rk-section-head"><h2 class="rk-heading">Status',
    );
    // A section inside a card is not boxed again, and its heading is one level down.
    expect(markup).toContain(
      '<section class="rk-section" id="inner" data-headed="true"><div class="rk-section-head"><h3 class="rk-heading">Inner',
    );
    expect(markup).toContain('<dl class="rk-properties" data-card="true">');
    expect(html(<Properties items={[]} />)).toBe('<dl class="rk-properties"></dl>');
    // A grid wider than four columns would squeeze every card unreadably thin.
    expect(markup).toContain("--rk-columns:4");
  });

  it("fails, instead of recursing forever, when a page renders its own Page again", () => {
    // What a page component named after the kit's Status does once it uses <Status>.
    function Looping(): React.ReactElement {
      return (
        <Page title="Shadowing">
          <Looping />
        </Page>
      );
    }
    expect(() => html(<Looping />)).toThrow(/rendered inside another <Page>/);
  });

  it("marks a lone point, which draws no line, with a dot and its value", () => {
    const one = html(<LineChart points={[{ label: "06:00", value: 1840 }]} />);
    expect(one).toContain('class="rk-line-dot"');
    expect(one).toContain(">1,840</text>");
    // Joined points draw a line and no dots on a single series.
    expect(html(<LineChart points={[{ value: 1 }, { value: 2 }]} />)).not.toContain("rk-line-dot");
  });

  it("lists only web sources as links and otherwise falls back to the column width", () => {
    const markup = html(
      <Page
        title="t"
        width={"huge" as never}
        sources={["https://example.com/a", "javascript:alert(1)"]}
      />,
    );
    expect(markup).toContain('data-width="column"');
    expect(markup).toContain(
      '<a class="rk-link" href="https://example.com/a" rel="noopener noreferrer">https://example.com/a</a>',
    );
    expect(markup).toContain("<li>javascript:alert(1)</li>");
    expect(html(<Page title="t" />)).not.toContain("rk-sources");
  });

  it("turns **strong**, *em*, `code` and bare links into markup and leaves lookalikes as text", () => {
    const markup = html(
      <Text>
        {
          "Ship **now**, *maybe* `npm test` at https://example.com/x). Keep PHONE_CALLS_ENABLED, 2 * 3 * 4, a*b*c, a*b* c, x *b*c and **open"
        }
      </Text>,
    );
    expect(markup).toContain(
      'Ship <strong>now</strong>, <em>maybe</em> <code class="rk-code">npm test</code> at <a class="rk-link" href="https://example.com/x" rel="noopener noreferrer">https://example.com/x</a>). Keep PHONE_CALLS_ENABLED, 2 * 3 * 4, a*b*c, a*b* c, x *b*c and **open',
    );
    // Bold that holds italics is read once, inside out.
    expect(html(<p>{inlineMarkup("**a *b* c**")}</p>)).toBe(
      "<p><strong>a <em>b</em> c</strong></p>",
    );
  });

  it("scans long unclosed markup in linear time", () => {
    for (const text of [
      "*a".repeat(25_000),
      "**".repeat(25_000),
      `\`${"x".repeat(50_000)}`,
      "`\n".repeat(25_000),
      "http://a".repeat(6_000),
      `${"_ ".repeat(25_000)}${"www.".repeat(12_500)}`,
    ]) {
      const start = performance.now();
      inlineMarkup(text);
      expect(performance.now() - start).toBeLessThan(200);
    }
  });

  it("shows a callout's lead and body in its tone and nothing when it is empty", () => {
    const toned = html(
      <Callout lead="Ship first" tone="warning">
        Body *text*
      </Callout>,
    );
    expect(toned).toMatch(
      /^<div class="rk-callout" role="note" data-tone="warning"><svg class="rk-callout-icon"/,
    );
    expect(toned).toContain(
      '<p class="rk-callout-lead">Ship first</p><p class="rk-callout-body">Body <em>text</em></p>',
    );
    const plain = html(<Callout tone={"purple" as never}>Plain</Callout>);
    expect(plain).not.toContain("data-tone");
    expect(plain).not.toContain("<svg");
    expect(html(<Callout />)).toBe("");
  });

  it("puts a status word in a tinted pill whose tone falls back to neutral", () => {
    expect(html(<Status tone="danger">Absent</Status>)).toBe(
      '<span class="rk-status rk-tone-danger" title="Absent"><span class="rk-status-dot" aria-hidden="true"></span><span class="rk-status-text">Absent</span></span>',
    );
    expect(html(<Status tone="success" />)).toBe("");
    expect(html(<Status tone="info">BYO</Status>)).toContain("rk-tone-accent");
    expect(html(<Status tone={"neutral"}>Draft</Status>)).toContain('class="rk-status"');
  });

  it("lists rows with their status, numbered steps and read-only checklist items", () => {
    const rows = html(
      <Rows
        rows={[
          { title: "Replace Pi", detail: "Keep it", status: { label: "Skip", tone: "warning" } },
          { title: "Bare" },
        ]}
      />,
    );
    // The status follows the title in its tone's ink, as in "Replace Pi · Skip".
    expect(rows).toContain(
      '<div class="rk-row-title">Replace Pi<span class="rk-row-status rk-tone-warning"> · Skip</span></div><div class="rk-row-detail">Keep it</div>',
    );
    expect(rows).toContain('<div class="rk-row-title">Bare</div></div></li>');
    expect(rows).not.toContain("rk-row-lead");
    const led = html(
      <Rows rows={[{ title: "Billing", lead: "Q3", meta: "$12,400" }, { title: "Owner" }]} />,
    );
    // One row's lead gives every row the lead column, so titles line up.
    expect(led).toContain('<ul class="rk-rows" data-leads="true">');
    expect(led).toContain('<span class="rk-row-lead">Q3</span>');
    expect(led).toContain('<span class="rk-row-meta">$12,400</span>');
    expect(led.match(/rk-row-lead/g)).toHaveLength(2);
    const steps = html(
      <Steps steps={[{ title: "Turn on" }, { title: "Measure", detail: "Time it" }]} />,
    );
    expect(steps).toMatch(/aria-hidden="true">1<\/span><div><div class="rk-step-title">Turn on/);
    expect(steps).toMatch(
      /aria-hidden="true">2<\/span><div><div class="rk-step-title">Measure<\/div><div class="rk-step-detail">Time it/,
    );
    const checklist = html(
      <Checklist
        items={[
          { text: "Dictate", done: true, meta: "shipped" },
          { text: "Stream", done: "yes" as never },
        ]}
      />,
    );
    expect(checklist).toMatch(/<input type="checkbox" disabled="" checked=""\/>.*<path/);
    expect(checklist).toContain('<div class="rk-check-meta">shipped</div>');
    // Only a real true counts as done: the second item is unticked and has no tick drawn.
    const second = checklist.slice(checklist.indexOf("shipped"));
    expect(second).toMatch(
      /<input type="checkbox" disabled=""\/><svg[^>]*><circle[^>]*><\/circle><\/svg>/,
    );
  });

  it("shows each figure above its label, at most four to a row, with tone on the detail", () => {
    const markup = html(
      <Metrics
        metrics={[
          { value: "2.1%", label: "Churn", tone: "warning", detail: "up from 1.8%" },
          { value: "398", label: "Users", tone: "purple" as never, detail: "flat" },
          { value: "1", label: "C" },
          { value: "2", label: "D" },
          { value: "3", label: "E" },
        ]}
      />,
    );
    expect(markup).toContain(
      '<div class="rk-metric-value" title="2.1%">2.1%</div><div class="rk-metric-label">Churn</div><div class="rk-metric-detail rk-tone-warning">up from 1.8%</div>',
    );
    expect(markup).toContain('<div class="rk-metric-detail">flat</div>');
    expect(markup).toContain("--rk-columns:4");
    expect(
      html(
        <Metrics
          metrics={[
            { value: "1", label: "A" },
            { value: "2", label: "B" },
          ]}
        />,
      ),
    ).toContain("--rk-columns:2");
  });

  it("aligns figures and short values to the end, prose and status to the start, unless told", () => {
    const markup = html(
      <Table
        columns={["Account", "Seats", "MRR", "Status", "Plan", "Note"]}
        rows={[
          [
            "Acme",
            42,
            "$1,200",
            { text: "Past due", tone: "danger" },
            "Business",
            "renews after the March review",
          ],
          ["Globex", 7, "-4.5%", <Status key="s">Ok</Status>, "Pro", "x"],
        ]}
        emphasis={1}
      />,
    );
    expect(markup).toContain('<span class="rk-tone-danger">Past due</span>');
    expect(markup).toContain('<td class="rk-align-end rk-emphasis">42</td>');
    expect(markup).toContain('<td class="rk-align-end">$1,200</td>');
    expect(markup).toContain('<th scope="col" class="rk-align-end">Plan</th>');
    for (const column of ["Account", "Status", "Note"])
      expect(markup).toContain(`<th scope="col">${column}</th>`);
    // Six columns scroll sideways, so the label column keeps a readable width.
    expect(markup).toContain('<table class="rk-table" data-wide="true">');
    const told = html(
      <Table columns={["Area", "Path"]} align={["center", "start"]} rows={[["Core", "x"]]} />,
    );
    expect(told).toContain('<table class="rk-table">');
    expect(told).toContain('<td class="rk-align-center">Core</td><td>x</td>');
    // Times and dates in a schedule line up as values too.
    const runs = html(
      <Table
        columns={["Routine", "Schedule", "Last run"]}
        rows={[
          ["Morning brief", <span key="a">Daily 07:00</span>, "Wed 09:00"],
          ["Calendar sync", <span key="b">Every 4 h</span>, "Oct 30"],
          ["Backup", <span key="c">Hourly</span>, ""],
        ]}
      />,
    );
    for (const column of ["Schedule", "Last run"])
      expect(runs).toContain(`<th scope="col" class="rk-align-end">${column}</th>`);
    expect(runs).toContain('<th scope="col">Routine</th>');
    // A phrase is prose and reads from the start; a single short word lines up as a value.
    const phrases = html(
      <Table
        columns={["Who", "Rebate"]}
        rows={[
          ["A", "PnS 11%"],
          ["B", "0%"],
        ]}
      />,
    );
    expect(phrases).toContain('<th scope="col">Rebate</th>');
  });

  it("marks a line chart's floor, middle and ceiling and thins x labels to fit", () => {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const markup = html(
      <LineChart
        points={[42, 51, 47, 63, 58, 71, 66].map((value, index) => ({ label: days[index], value }))}
        floor={0}
        ceiling={86}
        labels={["Signups"]}
      />,
    );
    expect(markup).toContain("<title>Signups: Mon 42, Tue 51, Wed 47,");
    const ticks = [...markup.matchAll(/dy="0.35em" text-anchor="end">([^<]*)<\/text>/g)].map(
      (m) => m[1],
    );
    expect(ticks).toEqual(["0", "43", "86"]);
    // Seven labels do not fit the default width, so every other one is drawn, ends included.
    for (const day of ["Mon", "Wed", "Fri", "Sun"]) expect(markup).toContain(`>${day}</text>`);
    for (const day of ["Tue", "Thu", "Sat"]) expect(markup).not.toContain(`>${day}</text>`);
    expect(
      html(<LineChart points={[{ value: 210 }, { value: 342 }]} floor={0} ceiling={411} />),
    ).toContain(">206</text>");
    expect(
      html(<LineChart points={[{ value: 1 }, { value: 2 }]} floor={0} ceiling={3} />),
    ).toContain(">1.5</text>");
    // Without a ceiling the top gridline is the next round value above the data.
    expect(html(<LineChart points={[{ value: 42 }, { value: 71 }]} />)).toContain(">80</text>");
  });

  it("scales bars to the largest, inks the largest by default, the chosen one, or all for none", () => {
    const bars = [
      { label: "Search", value: 25, display: "25%" },
      { label: "Direct", value: 50 },
    ];
    const emphasised = (markup: string) =>
      [...markup.matchAll(/data-emphasis="(true|false)"/g)].map((m) => m[1]);
    const auto = html(<Bars bars={bars} />);
    expect(emphasised(auto)).toEqual(["false", "true"]);
    expect(auto).toMatch(/data-emphasis="false">.*?style="width:50.00%"/);
    expect(auto).toContain('<span class="rk-bar-value">25%</span>');
    expect(emphasised(html(<Bars bars={bars} emphasis={0} />))).toEqual(["true", "false"]);
    expect(emphasised(html(<Bars bars={bars} emphasis="none" />))).toEqual(["true", "true"]);
  });

  it("splits a donut by each part's share of the total and lists the shares", () => {
    const markup = html(
      <Pie
        parts={[
          { label: "Starter", value: 540, display: "540 users" },
          { label: "Pro", value: 310 },
          { label: "Business", value: 90, display: "90 users" },
          { label: "Refunded", value: -5 },
        ]}
      />,
    );
    expect(markup).toContain(
      "<title>Starter 540 users, 57%; Pro 310, 33%; Business 90 users, 10%</title>",
    );
    // A part's arc is its share of the ring, less a small gap where the track shows, starting
    // where the previous part ended.
    const arcs = [
      ...markup.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)" stroke-dashoffset="(-?[\d.]+)"/g),
    ];
    expect(arcs).toHaveLength(3);
    const ring = Number(arcs[0]![2]);
    const gap = (540 / 940) * ring - Number(arcs[0]![1]);
    expect(gap).toBeGreaterThan(1);
    expect(gap).toBeLessThan(3);
    expect((Number(arcs[1]![1]) + gap) / ring).toBeCloseTo(310 / 940);
    expect(-Number(arcs[2]![3]) / ring).toBeCloseTo(850 / 940);
    expect(markup).toContain(
      '<span class="rk-pie-value">540 users</span><span class="rk-pie-label">Starter</span><span class="rk-pie-share">57%</span>',
    );
    expect(markup).toContain('style="stroke:var(--rk-c2)"');
    expect(markup).toContain('style="--rk-swatch:var(--rk-c2)"');
    expect(markup).not.toContain("Refunded");
  });

  it("lays a diagram out in layers along its edges, setting cycle edges aside", () => {
    const nodes = ["mic", "stt", "pi", "tts", "spk", "side"].map((id) => ({ id, label: id }));
    const edges = [
      { from: "mic", to: "stt" },
      { from: "stt", to: "pi" },
      { from: "pi", to: "tts" },
      { from: "tts", to: "spk" },
      { from: "mic", to: "side" },
      { from: "side", to: "pi" },
      { from: "pi", to: "side" },
      { from: "ghost", to: "pi" },
    ];
    const layout = layoutDiagram(nodes, edges, true, false);
    const layer = Object.fromEntries(layout.nodes.map((node) => [node.id, node.layer]));
    expect(layer).toEqual({ mic: 0, stt: 1, side: 1, pi: 2, tts: 3, spk: 4 });
    expect(
      layout.edges.filter((edge) => edge.backward).map(({ edge }) => `${edge.from}>${edge.to}`),
    ).toEqual(["pi>side"]);
    // Horizontal: a later layer always starts to the right of where the earlier one ends.
    const at = (id: string) => layout.nodes.find((node) => node.id === id)!;
    expect(at("pi").x).toBeGreaterThan(at("stt").x + at("stt").width);
    expect(
      layoutDiagram(nodes, edges, false, false).nodes.find((n) => n.id === "pi")!.y,
    ).toBeGreaterThan(at("stt").y);
    const markup = html(
      <Diagram
        direction="horizontal"
        nodes={nodes}
        edges={[{ from: "mic", to: "stt", label: "today", dashed: true }]}
      />,
    );
    expect(markup).toContain("mic to stt (today)");
    expect(markup).toContain('stroke-dasharray="5 4"');
  });

  it("wraps diagram labels at word breaks and splits a word too long for a line", () => {
    expect(wrapText("Voice sidecar for LiveKit agents", 12)).toEqual([
      "Voice",
      "sidecar for",
      "LiveKit",
      "agents",
    ]);
    expect(wrapText("supercalifragilistic", 8)).toEqual(["supercal", "ifragili", "stic"]);
  });

  it("wraps wide diagram text and sizes labels and details with the same estimate", () => {
    expect(wrapText("日本語の処理手順", 6)).toEqual(["日本語", "の処理", "手順"]);
    expect(wrapText("한".repeat(6).normalize("NFD"), 23)).toEqual(["한".repeat(6)]);
    expect(wrapText("अः".repeat(4), 4)).toEqual(["अःअः", "अःअः"]);
    expect(wrapText("✈️".repeat(4), 4)).toEqual(["✈️✈️", "✈️✈️"]);
    expect(wrapText(`${"日".repeat(10)}👩‍💻`, 23)).toEqual([`${"日".repeat(10)}👩‍💻`]);
    expect(wrapText("𐐀".repeat(12), 23)).toEqual(["𐐀".repeat(12)]);
    expect(wrapText("😀".repeat(4), 4)).toEqual(["😀😀", "😀😀"]);
    expect(wrapText(`${"a".repeat(21)}日\u0301`, 23)).toEqual([`${"a".repeat(21)}日\u0301`]);
    expect(wrapText("API 日本語", 7)).toEqual(["API", "日本語"]);
    expect(wrapText("中文ＡＢ", 4)).toEqual(["中文", "ＡＢ"]);
    const [node] = layoutDiagram(
      [{ id: "step", label: "日本語".repeat(8), detail: "中文".repeat(15) }],
      [],
      true,
      false,
    ).nodes;
    expect(node!.labelLines.every((line) => [...line].length <= 11)).toBe(true);
    expect(node!.detailLines.every((line) => [...line].length <= 13)).toBe(true);
    expect(node!.width).toBe(208);
    expect(node!.height).toBe(20 + 3 * 19 + 3 * 17);
    const [short] = layoutDiagram([{ id: "short", label: "日本語の処理" }], [], false, false).nodes;
    expect(short!.width).toBe(122);
    const [english] = layoutDiagram(
      [{ id: "en", label: "Review changes" }],
      [],
      false,
      false,
    ).nodes;
    expect(english!.width).toBe(138);
    expect(english!.labelLines).toEqual(["Review changes"]);
  });

  it("marks only the chosen segment pressed and accepts plain string options", () => {
    const markup = html(
      <Segmented options={["7d", { value: "30d", label: "Last 30 days" }]} value="30d" />,
    );
    expect(markup).toContain('aria-pressed="false"><span class="rk-segment">7d');
    expect(markup).toContain('aria-pressed="true"><span class="rk-segment">Last 30 days');
  });

  it.each([
    ["Metrics", <Metrics key="m" metrics={[]} />],
    ["Table", <Table key="t" columns={["A"]} rows={[]} />],
    ["LineChart", <LineChart key="l" points={[]} />],
    ["Bars", <Bars key="b" bars={[{ label: "None", value: 0 }]} />],
    ["Pie", <Pie key="p" parts={[{ label: "None", value: 0 }]} />],
    ["Diagram", <Diagram key="d" nodes={[]} edges={[{ from: "a", to: "b" }]} />],
    ["Rows", <Rows key="r" rows={[{ title: "x", status: { label: "" } }]} />],
    ["Segmented", <Segmented key="s" options={[]} />],
  ])("renders %s with empty data instead of failing the page", (_name, element) => {
    expect(() => html(element)).not.toThrow();
  });
});
