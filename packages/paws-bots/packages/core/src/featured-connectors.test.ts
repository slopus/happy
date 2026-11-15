import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildFeaturedConnectorTiles,
  featuredConnectorProvidersMatch,
  filterConnectionCatalogItems,
  integrationCatalogsReady,
  matchFeaturedConnectorId,
  resolveFeaturedCatalogItem,
} from "./featured-connectors.js";

function item(slug: string, name: string, connected = false): ConnectionCatalogItem {
  return {
    connectorId: "composio",
    slug,
    name,
    logo: null,
    connected,
    noAuth: false,
  };
}

it.each([
  [false, false, false, false, false],
  [true, false, false, false, false],
  [true, true, true, false, false],
  [true, false, true, true, false],
  [true, false, true, false, true],
])(
  "allows empty states only when both catalogs are available (%s, %s, %s, %s)",
  (catalogLoaded, catalogFailed, pluginsLoaded, pluginsUnavailable, expected) => {
    expect(
      integrationCatalogsReady({ catalogLoaded, catalogFailed, pluginsLoaded, pluginsUnavailable }),
    ).toBe(expected);
  },
);

describe("featured connectors", () => {
  it("maps gmail aliases to the same featured id", () => {
    expect(matchFeaturedConnectorId("gmail")).toBe("gmail");
    expect(matchFeaturedConnectorId("Google Mail")).toBe("gmail");
    expect(matchFeaturedConnectorId("GMAIL")).toBe("gmail");
    expect(featuredConnectorProvidersMatch("gmail", "Google Mail")).toBe(true);
  });

  it("maps calendar and drive catalog slugs", () => {
    expect(matchFeaturedConnectorId("googlecalendar")).toBe("google-calendar");
    expect(matchFeaturedConnectorId("google_drive")).toBe("google-drive");
    expect(matchFeaturedConnectorId("googledrive")).toBe("google-drive");
  });

  it("maps slack and notion catalog aliases", () => {
    expect(matchFeaturedConnectorId("slack")).toBe("slack");
    expect(matchFeaturedConnectorId("slackbot")).toBe("slack");
    expect(matchFeaturedConnectorId("SLACK")).toBe("slack");
    expect(matchFeaturedConnectorId("notion")).toBe("notion");
    expect(matchFeaturedConnectorId("notion.so")).toBe("notion");
    expect(matchFeaturedConnectorId("NOTION")).toBe("notion");
    expect(featuredConnectorProvidersMatch("slack", "slackbot")).toBe(true);
    expect(featuredConnectorProvidersMatch("notion", "notion.so")).toBe(true);
  });

  it("returns null for unknown catalog entries", () => {
    expect(matchFeaturedConnectorId("salesforce")).toBeNull();
    expect(matchFeaturedConnectorId("outlook")).toBeNull();
    expect(resolveFeaturedCatalogItem("gmail", [item("github", "GitHub")])).toBeUndefined();
  });

  it("resolves featured rows from slug or display name", () => {
    const catalog = [item("gmail", "Gmail"), item("slackbot", "Slack"), item("NOTION", "Notion")];
    expect(resolveFeaturedCatalogItem("gmail", catalog)?.slug).toBe("gmail");
    expect(resolveFeaturedCatalogItem("slack", catalog)?.slug).toBe("slackbot");
    expect(resolveFeaturedCatalogItem("notion", catalog)?.slug).toBe("NOTION");
  });

  it("marks all featured tiles missing when the catalog is empty", () => {
    const tiles = buildFeaturedConnectorTiles([]);
    expect(tiles).toHaveLength(5);
    expect(tiles.every((tile) => !tile.item && !tile.missing)).toBe(true);
  });

  it("marks unknown featured apps missing when the catalog has other apps", () => {
    const tiles = buildFeaturedConnectorTiles([item("gmail", "Gmail", true)]);
    const gmail = tiles.find((tile) => tile.id === "gmail");
    const drive = tiles.find((tile) => tile.id === "google-drive");
    expect(gmail?.item?.connected).toBe(true);
    expect(gmail?.missing).toBe(false);
    expect(drive?.missing).toBe(true);
    expect(drive?.item).toBeUndefined();
  });

  it("keeps featured apps in search while removing their duplicate browse rows", () => {
    const catalog = [
      item("gmail", "Gmail"),
      item("linear", "Linear"),
      { ...item("notion", "Notion"), connectorId: "pipedream" },
    ];

    expect(filterConnectionCatalogItems(catalog, "").map(({ name }) => name)).toEqual(["Linear"]);
    expect(filterConnectionCatalogItems(catalog, "mail").map(({ name }) => name)).toEqual([
      "Gmail",
    ]);
    expect(filterConnectionCatalogItems(catalog, "pipedream").map(({ name }) => name)).toEqual([
      "Notion",
    ]);
  });
});
