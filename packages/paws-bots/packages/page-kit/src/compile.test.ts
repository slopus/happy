import { afterEach, describe, expect, it } from "vitest";
import { pageViewerCode } from "./compile.js";

/** Runs viewer code the way the runtime's factory does, with only `exports` and `require`. */
function run(code: string) {
  const exports: { default?: () => unknown } = {};
  new Function("exports", "require", "React", code)(exports, () => ({}), {
    createElement: (type: unknown, props: unknown) => ({ type, props }),
  });
  return exports;
}

const sources = (globalThis as { __rakazoPageSources?: unknown }).__rakazoPageSources;
afterEach(() => {
  (globalThis as { __rakazoPageSources?: unknown }).__rakazoPageSources = sources;
});

describe("pageViewerCode", () => {
  it("declares the page's sources before it runs, keeping its line numbers and strict mode", () => {
    const code = pageViewerCode(
      '/* page-sources\n{"sales":{"rows":[1,2]}}\n*/\nexport default function App() {\n  undeclared = 1;\n}\n',
    );
    const exports = run(code);
    expect((globalThis as { __rakazoPageSources?: unknown }).__rakazoPageSources).toEqual({
      sales: { rows: [1, 2] },
    });
    // Strict like the source's own module code: the stray assignment throws, from line 5.
    expect(() => exports.default!()).toThrow(ReferenceError);
    expect(code.split("\n")[4]).toContain("undeclared = 1");
  });

  it("turns a page it cannot run into code that throws the reason", () => {
    const badSources = pageViewerCode("/* page-sources\n{oops}\n*/\nexport default 1;");
    const badSyntax = pageViewerCode("export default function App( {");
    expect(() => run(badSources)).toThrow(
      "The page-sources comment at the top of the page is not valid JSON.",
    );
    expect(() => run(badSyntax)).toThrow(/Unexpected token/);
  });
});
