import { PAGE_SOURCE_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { pageViewerCode } from "./compile.js";
import { PAGE_HELPERS, PAGE_KIT_COMPONENTS } from "./components.js";
import { checkPageSource, PAGE_KIT_GUIDE } from "./validate.js";

const page = (body: string) => `${body}\nexport default App;\n`;

describe("checkPageSource", () => {
  it("accepts the guide's own example, so the help text never teaches a rejected page", () => {
    const example = PAGE_KIT_GUIDE.slice(
      PAGE_KIT_GUIDE.indexOf("## Example") + "## Example".length,
    );
    // It also carries the viewer code, compiled once here for the save to keep.
    expect(checkPageSource(example)).toEqual({ ok: true, code: pageViewerCode(example) });
  });

  it("documents every component and helper the kit gives a page", () => {
    const undocumented = [...PAGE_KIT_COMPONENTS, ...PAGE_HELPERS].filter(
      (name) =>
        !new RegExp(`(^|[\\s(,])${name}\\b`, "m").test(
          PAGE_KIT_GUIDE.slice(PAGE_KIT_GUIDE.indexOf("## Components")),
        ),
    );
    expect(undocumented).toEqual([]);
  });

  it.each([
    [
      "kit components, hooks and fragments",
      "function App() { const [v] = useState(1); return <><Page title='t'><Text>{v}</Text></Page><React.Fragment /></>; }",
    ],
    [
      "a helper component defined in the file",
      "function Card({ children }) { return <Section>{children}</Section>; }\nfunction App() { return <Page title='t'><Card>x</Card></Page>; }",
    ],
    [
      "a component passed in as a prop",
      "function Wrap({ Icon }) { return <Icon />; }\nconst App = () => <Wrap Icon={Text} />;",
    ],
    [
      "lowercase HTML elements",
      "const App = () => <Page title='t'><div><strong>bold</strong></div></Page>;",
    ],
    [
      "imports of React and the kit, which change nothing",
      "import React, { useEffect } from 'react';\nimport * as Kit from 'rakazo/page';\nimport { Page as P, Status } from \"rakazo/page\";\nfunction App() { useEffect(() => {}, []); return <P title='t'><Status>ok</Status><Kit.Text /></P>; }",
    ],
    [
      "HTML escapes where JSX decodes them",
      'const App = () => <Text title="&lt;800ms">under &lt;800ms &amp; falling</Text>;',
    ],
    [
      "SVG and HTML elements with inline styles and handler functions",
      "const App = () => <Page title='t'><div style={{ display: 'grid' }} onClick={() => {}}><svg viewBox='0 0 10 10'><defs><linearGradient id='g'><stop offset='0' /></linearGradient></defs><path d='M0 0h10' /><circle r='2'><animate attributeName='r' /></circle><text>x</text></svg><img src='data:image/png;base64,AA==' alt='' /></div></Page>;",
    ],
    [
      "the structure, text and math components and the theme hook",
      "function App() { const t = useTheme(); return <Page title='t'><TableOfContents items={[{ label: 'a', id: 'a' }]} /><Section id='a' heading='A' collapsible><BulletList items={['x']} /><NumberedList items={['y']} /><ProsCons pros={['p']} cons={['c']} /><Quote cite='me'>q</Quote><LinkCards links={[]} /><Legend names={['n']} /><Equation><Frac num='1' den='2' /><Pow base='x' exp='2' /><Sqrt>y</Sqrt><Sum /><Paren>z</Paren></Equation></Section><Divider /><PageMeta>m</PageMeta><Footnote>f</Footnote><Floating><BackToTop /></Floating><span style={{ color: t.text.primary }} /></Page>; }",
    ],
    [
      "kit components and local components created without JSX",
      "function Card() { return null; }\nconst App = () => React.createElement(Page, { title: 't' }, React.createElement(Card), React.createElement(React.Fragment), React.createElement('div'));",
    ],
    [
      "a component of its own named like a blocked element",
      "function Script() { return <Text>x</Text>; }\nconst App = () => <Script />;",
    ],
    [
      "its own component declared with const under a kit component's name",
      "const Steps = () => <Text>own</Text>;\nconst App = () => <Page title='t'><Steps /></Page>;",
    ],
    [
      "require as a plain object key",
      "const notes = { require: 'sign-off' };\nconst App = () => <Text>{notes.require}</Text>;",
    ],
  ])("accepts %s", (_name, body) => {
    expect(checkPageSource(page(body))).toEqual({ ok: true, code: expect.any(String) });
  });

  // Each rejection names the line so the bot can fix the file before the user sees it.
  it.each([
    [
      "an import from any other module",
      "import x from 'lodash';\nconst App = () => <Text />;",
      'line 1: only "react" and "rakazo/page" can be imported',
    ],
    [
      "a dynamic import, even of React",
      "const App = () => <Text />;\nconst later = import('react');",
      'line 2: only "react" and "rakazo/page" can be imported',
    ],
    [
      "a name the kit does not have",
      "import { Page, Card as C } from 'rakazo/page';\nconst App = () => <Page title='t' />;",
      "line 1: Card is not in the kit",
    ],
    [
      "a default import from the kit",
      "import Kit from 'rakazo/page';\nconst App = () => <Text />;",
      'line 1: "rakazo/page" has no default export',
    ],
    [
      "require",
      "const fs = require('fs');\nconst App = () => <Text />;",
      "line 1: require is not available",
    ],
    [
      "a named export",
      "export const App = () => <Text />;",
      "line 1: only `export default` is allowed",
    ],
    [
      "an unknown component",
      "function App() {\n  return <Page title='t'>\n    <Card />\n  </Page>;\n}",
      "line 3: <Card> is not a kit component",
    ],
    [
      "an unknown member component",
      "const App = () => <Chart.Line />;",
      "line 1: <Chart> is not a kit component",
    ],
    [
      "an undeclared lowercase member component",
      "const App = () => <icons.Star />;",
      "line 1: <icons> is not a kit component",
    ],
    [
      "an unknown component created without JSX",
      "const App = () => React.createElement(\n  Dropdown, { value: 1 });",
      "line 2: <Dropdown> is not a kit component",
    ],
    [
      "a script element",
      "const App = () => <div><script>{'x'}</script></div>;",
      "line 1: <script> is not allowed",
    ],
    [
      "a style element",
      "const App = () => <style>{'p{}'}</style>;",
      "line 1: <style> is not allowed",
    ],
    [
      "an iframe",
      "const App = () => <iframe src='https://x.dev' />;",
      "line 1: <iframe> is not allowed",
    ],
    ["an object", "const App = () => <object data='x' />;", "line 1: <object> is not allowed"],
    ["an embed", "const App = () => <embed src='x' />;", "line 1: <embed> is not allowed"],
    [
      "foreignObject inside SVG",
      "const App = () => <svg>\n<foreignObject />\n</svg>;",
      "line 2: <foreignObject> is not allowed",
    ],
    [
      "an iframe spelled with a capital inside",
      "const App = () => <iFrame src='https://x.dev' />;",
      "line 1: <iFrame> is not allowed",
    ],
    [
      "an iframe made with createElement",
      "const App = () => React.createElement(\"iframe\", { src: 'https://x.dev' });",
      "line 1: <iframe> is not allowed",
    ],
    [
      "a script in odd case",
      "const App = () => <sCRIPT>{'x'}</sCRIPT>;",
      "line 1: <sCRIPT> is not allowed",
    ],
    [
      "an event handler written as a string",
      'const App = () => <button onclick="go()">Go</button>;',
      "line 1: onclick takes a function, not a string",
    ],
    [
      "an export list that names more than the default",
      "const App = () => <Text />;\nconst x = 1;\nexport { App as default, x };",
      "line 3: only `export default` is allowed",
    ],
    ["a syntax error", "function App() {\n  return <Page title='t'>;\n}", "line 2, column"],
  ])("rejects %s", (_name, body, expected) => {
    const result = checkPageSource(page(body));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join("\n")).toContain(expected);
  });

  it("accepts a default export written as an export list, as bundlers emit it", () => {
    expect(
      checkPageSource("const App = () => <Text />;\nexport {\n  App as default\n};\n"),
    ).toEqual({ ok: true, code: expect.any(String) });
  });

  it.each([
    ["no default export", "const App = () => <Text />;"],
    [
      "two default exports",
      "const App = () => <Text />;\nexport default App;\nexport default App;",
    ],
  ])("rejects a page with %s", (_name, source) => {
    expect(checkPageSource(source)).toEqual({
      ok: false,
      errors: ["The page needs exactly one `export default` of its top component."],
    });
  });

  it("reports at most twenty problems, so a repeated mistake cannot flood the bot's context", () => {
    const result = checkPageSource(page("import x from 'y';\n".repeat(30)));
    expect(result.ok ? [] : result.errors).toHaveLength(21);
    expect(result.ok ? "" : result.errors[20]).toBe("…and 10 more.");
  });

  it("warns, without refusing, about HTML escapes that a JavaScript string shows as typed", () => {
    const result = checkPageSource(
      page(
        "const target = '&lt;800ms';\nconst note = `a &amp; b`;\nconst App = () => <Text>{target}{note}</Text>;",
      ),
    );
    expect(result).toEqual({
      ok: true,
      code: expect.any(String),
      warnings: [
        "line 1: &lt; in a JavaScript string shows up literally; write the plain character instead.",
        "line 2: &amp; in a JavaScript string shows up literally; write the plain character instead.",
      ],
    });
    // A lone ampersand or an unknown name is ordinary text.
    expect(
      checkPageSource(page("const s = 'R&D &copy; & co';\nconst App = () => <Text>{s}</Text>;")),
    ).toEqual({ ok: true, code: expect.any(String) });
  });

  it("rejects a component named like a kit component that uses that component inside itself", () => {
    const result = checkPageSource(
      'export default function Status() {\n  return <Page title="t"><Status tone="success">Up</Status></Page>;\n}\n',
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual([
      expect.stringMatching(/^line 1: your own `Status` replaces the kit's Status/),
    ]);
    // Compiled pages say createElement(Table, ...) where JSX says <Table>.
    expect(
      checkPageSource(
        page(
          "function Table() { return React.createElement(Table, null); }\nconst App = () => <Table />;",
        ),
      ).ok,
    ).toBe(false);
    // Real pages reuse kit names for their own helpers; harmless when not used inside.
    expect(
      checkPageSource(
        page(
          "function Steps({ step }) { return <svg><rect width={step} /></svg>; }\nfunction copyText(t) { return t; }\nconst App = () => <Page title='t'><Steps step={2} /></Page>;",
        ),
      ),
    ).toEqual({ ok: true, code: expect.any(String) });
  });

  it.each([
    "function () { return <Status />; }",
    "() => <Status />",
    "() => React.createElement(Status, null)",
  ])("accepts a harmless kit-name helper before default export %s", (exported) => {
    expect(
      checkPageSource(
        `function Status() { return <Text>Ready</Text>; }\nexport default ${exported};`,
      ),
    ).toEqual({ ok: true, code: expect.any(String) });
  });

  it("still rejects a recursive helper before an anonymous default export", () => {
    expect(
      checkPageSource(
        "function Status() { return <Status />; }\nexport default function () { return <Status />; }",
      ).ok,
    ).toBe(false);
  });

  it("limits a page's size in bytes, not characters, before parsing it", () => {
    const head = "const App = () => <Text>x</Text>;\n// ";
    const room = PAGE_SOURCE_MAX_BYTES - new TextEncoder().encode(page(head)).byteLength;
    const errors = (filler: string) => {
      const result = checkPageSource(page(head + filler));
      return result.ok ? [] : result.errors;
    };
    expect(errors("x".repeat(room))).toEqual([]);
    expect(errors("x".repeat(room + 1))).toEqual([
      "The page is 262145 bytes; the limit is 262144. Move data out or split the page.",
    ]);
    // Fewer characters than the limit, but two bytes each.
    expect(errors("é".repeat(Math.ceil((room + 1) / 2)))[0]).toMatch(/^The page is 26214\d bytes;/);
  });
  it("accepts every runtime helper by name and rejects an import the kit does not have", () => {
    for (const name of PAGE_HELPERS)
      expect(
        checkPageSource(
          `import {${name}} from 'rakazo/page'; export default function App(){return <Page title="x"/>}`,
        ).ok,
      ).toBe(true);
    expect(
      checkPageSource(
        `import {missing} from 'rakazo/page'; export default function App(){return <Page title="x"/>}`,
      ).ok,
    ).toBe(false);
  });

  it("rejects a page whose source list is not valid JSON", () => {
    expect(
      checkPageSource(
        '/* page-sources\n{bad json}\n*/\nexport default function App(){return <Page title="x"/>}',
      ).ok,
    ).toBe(false);
  });

  it("accepts the chart and data components as reference pages write them", () => {
    const source = `export default function App() {
  return (
    <Page title="Charts">
      <Columns points={[{ label: "Jan", value: 3 }]} emphasis={0} />
      <ColumnSeries labels={["Jan"]} series={[{ name: "A", values: [1] }]} stacked reference={{ value: 1, label: "Goal" }} />
      <StackedBars series={["Done"]} bars={[{ label: "Design", values: [2] }]} />
      <Scatter points={[{ x: 1, y: 2 }]} x={{ name: "Spend" }} trend />
      <Heatmap rows={["Mon"]} columns={["9a"]} values={[[1]]} />
      <CalendarHeatmap days={[{ date: "2026-01-01", value: 1 }]} />
      <Venn sets={[{ label: "A", count: 1 }]} overlap="1" />
      <Matrix2x2 axes={{ x: ["Low", "High"], y: ["Low", "High"] }} quadrants={["a", "b", "c", "d"]} points={[]} />
      <SourceStamp source={{ asOf: "2026-01-01", fresh: false }} />
    </Page>
  );
}`;
    expect(checkPageSource(source)).toEqual({ ok: true, code: expect.any(String) });
  });
  describe("a hook called outside a component", () => {
    it("rejects a hook at the top level of the file, which crashes the viewer", () => {
      const result = checkPageSource(
        "const t = useTheme();\nexport default function App() { return <Text>{t.text.primary}</Text>; }\n",
      );
      expect(result.ok).toBe(false);
      expect(result.ok ? [] : result.errors).toContain(
        "line 1: useTheme() must be called inside a component, not at the top level of the file.",
      );
    });

    it("handles a source-sized sequence of semicolon-free arrows and ends their scopes", () => {
      const declarations = Array.from({ length: 12000 }, (_, i) => `const a${i}=()=>1`).join("\n");
      const result = checkPageSource(
        `${declarations}\nconst value=useState(0)\nexport default () => <Text>Hello</Text>`,
      );
      expect(result.ok).toBe(false);
      expect(result.ok ? [] : result.errors).toContain(
        "line 12001: useState() must be called inside a component, not at the top level of the file.",
      );
    });

    it("rejects an exported hook at the top level of the file", () => {
      const result = checkPageSource(
        "export const t = useTheme();\nexport default function App() { return <Text>{t.text.primary}</Text>; }\n",
      );
      expect(result.ok).toBe(false);
      expect(result.ok ? [] : result.errors).toContain(
        "line 1: useTheme() must be called inside a component, not at the top level of the file.",
      );
    });

    it("rejects a hook at the top level of the file whatever the hook is", () => {
      const result = checkPageSource(
        "const [v] = useState(1);\nexport default function App() { return <Text>{v}</Text>; }\n",
      );
      expect(result.ok).toBe(false);
      expect(result.ok ? [] : result.errors).toContain(
        "line 1: useState() must be called inside a component, not at the top level of the file.",
      );
    });

    it("accepts a hook inside a component", () => {
      expect(
        checkPageSource(
          "export default function App() { const t = useTheme(); return <Text>{t.text.primary}</Text>; }\n",
        ),
      ).toEqual({ ok: true, code: expect.any(String) });
    });

    it("accepts a hook inside a component written as an arrow", () => {
      expect(
        checkPageSource(
          "const App = () => { const [v] = useState(1); return <Text>{v}</Text>; };\nexport default App;\n",
        ),
      ).toEqual({ ok: true, code: expect.any(String) });
    });

    it("accepts a hook inside a nested function", () => {
      expect(
        checkPageSource(
          "function inner() { const t = useTheme(); return t; }\nfunction App() { return <Text>{inner().text.primary}</Text>; }\nexport default App;\n",
        ),
      ).toEqual({ ok: true, code: expect.any(String) });
    });

    it("accepts a hook that is referenced but not called", () => {
      expect(
        checkPageSource(
          "const f = useTheme;\nexport default function App() { return <Text>{f().text.primary}</Text>; }\n",
        ),
      ).toEqual({ ok: true, code: expect.any(String) });
    });

    it("accepts a hook used as a property of something else", () => {
      expect(
        checkPageSource(
          "const helpers = { useTheme };\nexport default function App() { return <Text>{helpers.useTheme().text.primary}</Text>; }\n",
        ),
      ).toEqual({ ok: true, code: expect.any(String) });
    });

    it("accepts an ordinary function called at the top level of the file", () => {
      expect(
        checkPageSource(
          "const total = sum([1, 2, 3]);\nexport default function App() { return <Text>{total}</Text>; }\n",
        ),
      ).toEqual({ ok: true, code: expect.any(String) });
    });

    it("accepts a page that keeps its own hook, so the name is not React's", () => {
      expect(
        checkPageSource(
          "function useTotal() { return 3; }\nconst total = useTotal();\nexport default function App() { return <Text>{total}</Text>; }\n",
        ),
      ).toEqual({ ok: true, code: expect.any(String) });
    });
  });
});
