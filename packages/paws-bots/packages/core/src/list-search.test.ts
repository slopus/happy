import { describe, expect, it } from "vitest";
import { listSearch, MODEL_SEARCH_THRESHOLD } from "./list-search.js";

const items = [
  { id: "one", name: "Café", provider: "First" },
  { id: "two", name: "Other", provider: "Second" },
];
const options = {
  text: (item: (typeof items)[number]) => [item.name, item.provider],
  id: (item: (typeof items)[number]) => item.id,
  selectedIds: ["one", "one", "missing"],
};

describe("listSearch", () => {
  it("searches all fields with the shared Unicode matcher and counts hidden selections once", () => {
    expect(listSearch(items, " CAFÉ ", options)).toEqual({
      showSearch: true,
      visible: [items[0]],
      hiddenSelectedCount: 0,
    });
    expect(listSearch(items, "second", options)).toEqual({
      showSearch: true,
      visible: [items[1]],
      hiddenSelectedCount: 1,
    });
    expect(listSearch(items, "missing", options).hiddenSelectedCount).toBe(1);
    expect(options.selectedIds).toEqual(["one", "one", "missing"]);
  });
  it("shows search only above the full-list threshold or while a trimmed query is active", () => {
    const rows = Array.from({ length: MODEL_SEARCH_THRESHOLD }, (_, id) => String(id));
    const text = (id: string) => id;
    expect(listSearch(rows, "", { text }).showSearch).toBe(false);
    expect(listSearch([...rows, "extra"], "", { text }).showSearch).toBe(true);
    expect(listSearch([], "active", { text })).toEqual({
      showSearch: true,
      visible: [],
      hiddenSelectedCount: 0,
    });
    expect(listSearch(rows, "  ", { text }).visible).toBe(rows);
    expect(listSearch(rows, "  ", { text }).showSearch).toBe(false);
    expect(listSearch(items, "", { ...options, threshold: 1 }).showSearch).toBe(true);
  });
});
