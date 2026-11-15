import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { connectedAppMarks } from "./connected-apps";

const catalog: ConnectionCatalogItem[] = [
  {
    connectorId: "demo",
    slug: "alpha",
    name: "Alpha",
    logo: null,
    connected: false,
    noAuth: false,
  },
  { connectorId: "demo", slug: "beta", name: "Beta", logo: null, connected: false, noAuth: false },
  {
    connectorId: "demo",
    slug: "gamma",
    name: "Gamma",
    logo: null,
    connected: false,
    noAuth: false,
  },
  {
    connectorId: "demo",
    slug: "delta",
    name: "Delta",
    logo: "https://example.test/delta.svg",
    connected: false,
    noAuth: false,
  },
];

it("uses artwork-first catalog suggestions without changing the fetched order", () => {
  expect(connectedAppMarks(catalog, [])).toEqual([
    { name: "Delta", logo: "https://example.test/delta.svg" },
    { name: "Alpha", logo: null },
    { name: "Beta", logo: null },
  ]);
  expect(catalog[0]!.name).toBe("Alpha");
});

it("uses familiar app artwork before arbitrary catalog suggestions", () => {
  const items = ["Gmail", "Obscure App", "GitHub", "Notion"].map((name) => ({
    ...catalog[0]!,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    name,
    logo: `https://example.test/${name.toLowerCase().replaceAll(" ", "-")}.svg`,
  }));
  expect(connectedAppMarks(items, []).map((app) => app.name)).toEqual([
    "Gmail",
    "GitHub",
    "Notion",
  ]);
  expect(items[1]!.name).toBe("Obscure App");
  expect(
    connectedAppMarks(
      items.map((item) => ({ ...item, connected: item.slug === "obscure-app" })),
      [],
    ).map((app) => app.name),
  ).toEqual(["Obscure App"]);
});

it("shows connected apps instead of suggestions and returns suggestions after disconnect", () => {
  expect(
    connectedAppMarks(
      catalog.map((item, index) => ({ ...item, connected: index === 1 })),
      [],
    ),
  ).toEqual([{ name: "Beta", logo: null }]);
  expect(connectedAppMarks(catalog, [])).toHaveLength(3);
  expect(connectedAppMarks([], [])).toEqual([]);
});

it("deduplicates suggestions and preserves catalog order when artwork is missing", () => {
  const letters = catalog.slice(0, 3);
  expect(connectedAppMarks([letters[0]!, ...letters], [])).toEqual(
    letters.map(({ name, logo }) => ({ name, logo })),
  );
});

for (const connected of [false, true]) {
  it(`prefers distinct fallback initials for ${connected ? "connected apps" : "suggestions"}`, () => {
    const items = ["Gamma", "Garden", "Guide", "Alpha", "Beta"].map((name) => ({
      ...catalog[0]!,
      name,
      slug: name.toLowerCase(),
      connected,
    }));
    expect(connectedAppMarks(items, []).map((app) => app.name)).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(connectedAppMarks(items.slice(0, 3), []).map((app) => app.name)).toEqual([
      "Gamma",
      "Garden",
      "Guide",
    ]);
  });
}
