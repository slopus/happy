import { describe, expect, it } from "vitest";
import type { HastNode } from "./table-utils";
import {
  columnSortLabel,
  compareCellText,
  extractTable,
  isNumericColumn,
  nextSort,
  parseNumericText,
  sortRows,
  tableToCsv,
  tableToTsv,
} from "./table-utils";

const text = (value: string): HastNode => ({ type: "text", value });
const cell = (tagName: "th" | "td", value: string, align?: string): HastNode => ({
  tagName,
  children: [text(value)],
  properties: align ? { align } : {},
});
const row = (...cells: HastNode[]): HastNode => ({ tagName: "tr", children: cells });
const table = (children: HastNode[]): HastNode => ({ tagName: "table", children });

const simpleTable = () =>
  table([
    { tagName: "thead", children: [row(cell("th", "Name"), cell("th", "Price"))] },
    {
      tagName: "tbody",
      children: [
        row(cell("td", "Alpha"), cell("td", "3")),
        row(cell("td", "Beta"), cell("td", "10")),
        row(cell("td", "Gamma"), cell("td", "1")),
      ],
    },
  ]);

describe("extractTable", () => {
  it("reads columns and rows from a thead/tbody tree", () => {
    expect(extractTable(simpleTable())).toMatchObject({
      columns: ["Name", "Price"],
      aligns: [null, null],
      rows: [
        ["Alpha", "3"],
        ["Beta", "10"],
        ["Gamma", "1"],
      ],
    });
  });

  it("handles tables without thead", () => {
    const node = table([
      row(cell("th", "A"), cell("th", "B")),
      row(cell("td", "1"), cell("td", "2")),
    ]);
    expect(extractTable(node)).toMatchObject({
      columns: ["A", "B"],
      aligns: [null, null],
      rows: [["1", "2"]],
    });
  });

  it("flattens inline markup in cells to text", () => {
    const node = table([
      row(cell("th", "Name")),
      row({ tagName: "td", children: [{ tagName: "strong", children: [text("bold")] }] }),
    ]);
    expect(extractTable(node)?.rows[0]?.[0]).toBe("bold");
  });

  it("pads short rows and drops extra cells", () => {
    const node = table([
      row(cell("th", "A"), cell("th", "B")),
      row(cell("td", "1")),
      row(cell("td", "1", undefined), cell("td", "2"), cell("td", "3")),
    ]);
    expect(extractTable(node)?.rows).toEqual([
      ["1", ""],
      ["1", "2"],
    ]);
  });

  it("reads column alignment", () => {
    const node = table([
      row(
        cell("th", "Auto"),
        cell("th", "L", "left"),
        cell("th", "R", "right"),
        cell("th", "C", "center"),
      ),
      row(cell("td", "0"), cell("td", "1"), cell("td", "2"), cell("td", "3")),
    ]);
    expect(extractTable(node)?.aligns).toEqual([null, "left", "right", "center"]);
  });

  it("keeps a space where a <br> was dropped and preserves image alt text", () => {
    const node = table([
      row(cell("th", "A"), cell("th", "B")),
      row(
        { tagName: "td", children: [text("one"), { tagName: "br" }, text("two")] },
        {
          tagName: "td",
          children: [{ tagName: "img", properties: { alt: "chart alt" } }],
        },
      ),
      row(
        { tagName: "td", children: [text("x"), { type: "raw", value: "<br>" }, text("y")] },
        {
          tagName: "td",
          children: [{ type: "raw", value: '<img src="u" alt="logo &amp; mark">' }],
        },
      ),
    ]);
    expect(extractTable(node)?.rows).toEqual([
      ["one two", "chart alt"],
      ["x y", "logo & mark"],
    ]);
  });

  it.each([
    '<img alt="Chart" data-alt="Decorative">',
    '<img title="1 > 0" alt="Chart">',
    '<img alt="Chart" title="alt=Decorative">',
  ])("uses the real image description for copied and exported rows: %s", (html) => {
    const extracted = extractTable(
      table([
        row(cell("th", "Description")),
        row({ tagName: "td", children: [{ type: "raw", value: html }] }),
      ]),
    );
    expect(extracted?.rows).toEqual([["Chart"]]);
    expect(tableToTsv(extracted!.columns, extracted!.rows)).toBe("Description\nChart");
    expect(tableToCsv(extracted!.columns, extracted!.rows)).toBe("Description\nChart");
  });

  it("returns null for malformed nodes", () => {
    expect(extractTable(undefined)).toBeNull();
    expect(extractTable({})).toBeNull();
    expect(extractTable(table([]))).toBeNull();
    expect(extractTable(table([{ tagName: "caption" }]))).toBeNull();
  });

  it("produces identical signatures for identical content across re-parses", () => {
    // A streaming re-parse yields fresh node objects; content signatures must
    // still match so downstream work keyed on them can be skipped.
    const first = extractTable(simpleTable());
    const second = extractTable(simpleTable());
    expect(first?.schemaKey).toBe(second?.schemaKey);
    expect(first?.dataSignature).toBe(second?.dataSignature);
  });

  it("changes schemaKey only when columns or aligns change", () => {
    const base = extractTable(simpleTable());
    const sameSchemaExtraRow = extractTable(
      table([
        { tagName: "thead", children: [row(cell("th", "Name"), cell("th", "Price"))] },
        {
          tagName: "tbody",
          children: [
            row(cell("td", "Alpha"), cell("td", "3")),
            row(cell("td", "Beta"), cell("td", "10")),
            row(cell("td", "Gamma"), cell("td", "1")),
            row(cell("td", "Delta"), cell("td", "4")),
          ],
        },
      ]),
    );
    const renamed = extractTable(
      table([
        row(cell("th", "Title"), cell("th", "Price")),
        row(cell("td", "Alpha"), cell("td", "3")),
      ]),
    );
    expect(sameSchemaExtraRow?.schemaKey).toBe(base?.schemaKey);
    expect(sameSchemaExtraRow?.dataSignature).not.toBe(base?.dataSignature);
    expect(renamed?.schemaKey).not.toBe(base?.schemaKey);
  });

  it("derives numeric columns, min widths, and unique keys for duplicate rows", () => {
    const extracted = extractTable(
      table([
        row(cell("th", "Name"), cell("th", "Qty")),
        row(cell("td", "a"), cell("td", "1")),
        row(cell("td", "a"), cell("td", "1")),
        row(cell("td", "b"), cell("td", "2")),
      ]),
    );
    expect(extracted?.numericColumns.has(1)).toBe(true);
    expect(extracted?.numericColumns.has(0)).toBe(false);
    expect(extracted?.minWidths[1]).toContain("ch");
    const keys = extracted?.rows.map((row) => extracted?.rowKeys.get(row));
    expect(new Set(keys).size).toBe(3);
  });
});

describe("parseNumericText", () => {
  it("parses plain and formatted numbers", () => {
    expect(parseNumericText("42")).toBe(42);
    expect(parseNumericText("-3.5")).toBe(-3.5);
    expect(parseNumericText("1,234.56")).toBe(1234.56);
    expect(parseNumericText("$1,200")).toBe(1200);
    expect(parseNumericText("45%")).toBe(45);
    expect(parseNumericText("(12)")).toBe(-12);
    expect(parseNumericText("(-12)")).toBe(-12);
  });

  it("parses decimals without a leading zero", () => {
    for (const [text, expected] of [
      [".5", 0.5],
      [".25", 0.25],
      ["-.5", -0.5],
      ["(.25)", -0.25],
      ["$.50", 0.5],
      [".5%", 0.5],
    ] as const) {
      expect(parseNumericText(text)).toBe(expected);
    }
  });

  it("parses an explicit plus sign and the typographic minus", () => {
    for (const [text, expected] of [
      ["+5", 5],
      ["+12%", 12],
      ["+$5", 5],
      ["+1,234.5", 1234.5],
      ["+.5", 0.5],
      ["\u22125", -5],
      ["\u22123.2%", -3.2],
      ["$\u22125", -5],
    ] as const) {
      expect(parseNumericText(text)).toBe(expected);
    }
  });

  it("treats a delta column with signs as numeric", () => {
    const rows = [["+12%"], ["-3%"], ["+5%"], ["\u22122%"]];
    expect(isNumericColumn(rows, 0)).toBe(true);
  });

  it("rejects a stray or doubled sign", () => {
    for (const text of ["+", "++5", "+-5", "-+5", "5+", "\u2212", "+(5)"]) {
      expect(parseNumericText(text)).toBeNull();
    }
  });

  it("rejects incomplete or malformed decimals", () => {
    for (const text of [".", "-.", "(.)", "1.", "..5", ".5.0", "1,23.5"]) {
      expect(parseNumericText(text)).toBeNull();
    }
  });

  it("rejects non-numeric text", () => {
    for (const value of ["", "  ", "abc", "1,2,3,4,5", "NaN", "1.2.3", "-", "$", "12px"]) {
      expect(parseNumericText(value)).toBeNull();
    }
  });
});

describe("isNumericColumn", () => {
  const rows = [
    ["1", "a"],
    ["2", ""],
    ["", "b"],
  ];

  it("is true when every non-empty cell is numeric", () => {
    expect(isNumericColumn(rows, 0)).toBe(true);
  });

  it("recognizes leading-dot decimals in numeric columns", () => {
    expect(isNumericColumn([[".5"], ["-.25"], [""], ["1"]], 0)).toBe(true);
  });

  it("is false when a cell is not numeric or all cells are empty", () => {
    expect(isNumericColumn(rows, 1)).toBe(false);
    expect(isNumericColumn([[""], [""]], 0)).toBe(false);
  });
});

describe("sortRows", () => {
  const rows = [
    ["Beta", "10"],
    ["Alpha", "3"],
    ["Gamma", ""],
    ["Delta", "1"],
  ];

  it("sorts numeric columns numerically, not lexicographically", () => {
    expect(sortRows(rows, 1, "asc").map((r) => r[0])).toEqual(["Delta", "Alpha", "Beta", "Gamma"]);
  });

  it("keeps empty cells at the bottom in both directions", () => {
    expect(sortRows(rows, 1, "desc").map((r) => r[0])).toEqual(["Beta", "Alpha", "Delta", "Gamma"]);
    expect(sortRows(rows, 1, "asc").at(-1)).toEqual(["Gamma", ""]);
  });

  it("sorts leading-dot decimals with other numbers in both directions", () => {
    const values = [[".5"], [""], ["2"], ["-.5"], [".25"], ["0.1"]];
    expect(sortRows(values, 0, "asc")).toEqual([["-.5"], ["0.1"], [".25"], [".5"], ["2"], [""]]);
    expect(sortRows(values, 0, "desc")).toEqual([["2"], [".5"], [".25"], ["0.1"], ["-.5"], [""]]);
  });

  it("sorts text columns with locale compare", () => {
    expect(sortRows(rows, 0, "asc").map((r) => r[0])).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
  });
});

describe("nextSort", () => {
  it("cycles asc → desc → none and restarts on column change", () => {
    expect(nextSort(null, 0)).toEqual({ column: 0, direction: "asc" });
    expect(nextSort({ column: 0, direction: "asc" }, 0)).toEqual({ column: 0, direction: "desc" });
    expect(nextSort({ column: 0, direction: "desc" }, 0)).toBeNull();
    expect(nextSort({ column: 0, direction: "desc" }, 1)).toEqual({ column: 1, direction: "asc" });
  });
});

describe("columnSortLabel", () => {
  it("localizes generated names and collisions while preserving literal headers", () => {
    const copy = {
      columnFallback: (index: number) => `Spalte ${index}`,
      columnDuplicate: (header: string, index: number) => `${header}, Spalte ${index}`,
      columnCollision: (label: string) => `${label}, leer`,
    };
    expect(columnSortLabel(["", "Spalte 1", "Spalte 1, leer"], 0, copy)).toBe(
      "Spalte 1, leer, leer",
    );
    expect(columnSortLabel(["", "Spalte 1"], 1, copy)).toBe("Spalte 1");
    expect(columnSortLabel(["Name", "Name", "Name, Spalte 1"], 0, copy)).toBe(
      "Name, Spalte 1, leer",
    );
    expect(columnSortLabel(["Name", "Name"], 1, copy)).toBe("Name, Spalte 2");
  });

  it("returns the header when unique and non-empty", () => {
    expect(columnSortLabel(["Item", "Qty"], 0)).toBe("Item");
  });

  it("falls back to position for empty headers", () => {
    expect(columnSortLabel(["", "Qty"], 0)).toBe("column 1");
  });

  it("disambiguates duplicate headers", () => {
    expect(columnSortLabel(["Qty", "Qty"], 0)).toBe("Qty, column 1");
    expect(columnSortLabel(["Qty", "Qty"], 1)).toBe("Qty, column 2");
  });

  it("disambiguates empty fallbacks that collide with a literal header", () => {
    expect(columnSortLabel(["", "column 1"], 0)).toBe("column 1, empty");
    expect(columnSortLabel(["", "column 1"], 1)).toBe("column 1");
  });

  it("keeps suffixing while a literal header claims the label", () => {
    expect(columnSortLabel(["", "column 1", "column 1, empty"], 0)).toBe("column 1, empty, empty");
    expect(columnSortLabel(["a", "a", "a, column 1"], 0)).toBe("a, column 1, empty");
  });
});

describe("serialization", () => {
  const columns = ["Name", "Note"];
  const rows = [
    ["a,b", 'say "hi"'],
    ["=cmd", "line\nbreak"],
  ];

  it("quotes CSV cells containing separators and doubles quotes", () => {
    expect(tableToCsv(columns, [["a,b", 'say "hi"']].concat([["=cmd", "x"]]))).toBe(
      'Name,Note\n"a,b","say ""hi"""\n\'=cmd,x',
    );
  });

  it("neutralizes spreadsheet formulas on CSV export", () => {
    const csv = tableToCsv(
      ["=Name", "+Note"],
      [
        ["=1+1", "+SUM(A1)"],
        ["@lookup", "-9"],
      ],
    );
    for (const cell of csv.split(/[,\n]/)) expect(cell.startsWith("'")).toBe(true);
  });

  it("quotes CSV cells containing carriage returns", () => {
    expect(tableToCsv(["A"], [["x\ry"]])).toBe('A\n"x\ry"');
    // A CR must not smuggle a formula past the neutralizer into a new row.
    expect(tableToCsv(["A"], [["a\r=cmd"]])).toBe('A\n"a\r=cmd"');
  });

  it("neutralizes formulas hidden behind leading whitespace", () => {
    expect(tableToCsv(["A"], [["  =cmd"]])).toBe("A\n'  =cmd");
    expect(tableToTsv(["A"], [["\t=cmd"]])).toBe("A\n' =cmd");
  });

  it.each([
    ['"draft"', '"""draft"""'],
    ['"draft', '"""draft"'],
    ['say "hi"', '"say ""hi"""'],
    ['a""b', '"a""""b"'],
    ['"', '""""'],
  ])("preserves quotes in TSV headers and cells: %s", (value, encoded) => {
    expect(tableToTsv([value], [[value]])).toBe(`${encoded}\n${encoded}`);
  });

  it("closes quoted TSV cells before subsequent columns and rows", () => {
    expect(
      tableToTsv(
        ["Name", "Note"],
        [
          ['"draft', "pending"],
          ["next", "done"],
        ],
      ),
    ).toBe('Name\tNote\n"""draft"\tpending\nnext\tdone');
  });

  it("keeps TSV whitespace normalization and formula neutralization when quoting", () => {
    expect(tableToTsv(["Note"], [['say\t"hi"\r\nthere'], ['\t="draft"']])).toBe(
      'Note\n"say ""hi""  there"\n"\' =""draft"""',
    );
  });

  it("strips tabs/newlines in TSV and neutralizes formulas", () => {
    const tsv = tableToTsv(columns, rows);
    expect(tsv.split("\n")).toHaveLength(3);
    expect(tsv).toContain('a,b\t"say ""hi"""');
    expect(tsv).toContain("'=cmd\tline break");
    expect(tableToTsv(["=A", "+B"], [["@x", "-9"]])).toBe("'=A\t'+B\n'@x\t'-9");
  });

  it("pads short rows to the column count", () => {
    expect(tableToCsv(["A", "B"], [["1"]])).toBe("A,B\n1,");
  });
});

describe("compareCellText", () => {
  it("compares numerically when both parse", () => {
    expect(compareCellText("2", "10")).toBeLessThan(0);
    expect(compareCellText("$5", "5")).toBe(0);
  });
});
