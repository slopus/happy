import type { PluginMarketplaceEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  comparePlugins,
  installedPluginParts,
  managedAppFor,
  matchesPluginQuery,
  matchesWordPrefixes,
  pluginCategory,
} from "./plugin-catalog.js";

function entry(
  overrides: Partial<PluginMarketplaceEntry> & { name: string },
): PluginMarketplaceEntry {
  return {
    id: `Cursor:${overrides.name}`,
    displayName: overrides.name,
    description: "",
    keywords: [],
    category: null,
    logo: null,
    homepage: null,
    domains: [],
    registry: "Cursor",
    source: `https://github.com/example/${overrides.name}`,
    installedSource: `https://github.com/example/${overrides.name}`,
    hasConnector: true,
    skillCount: 0,
    ...overrides,
  };
}

describe("pluginCategory", () => {
  it("places known brands before the registry's own label", () => {
    expect(pluginCategory({ name: "hubspot", category: "integrations" })).toBe("sales");
    expect(pluginCategory({ name: "figma", category: "development" })).toBe("design");
    expect(pluginCategory({ name: "stripe", category: "development" })).toBe("finance");
  });
  it("maps the registries' technical labels and drops generic ones", () => {
    expect(pluginCategory({ name: "railway", category: "deployment" })).toBe("ops");
    expect(pluginCategory({ name: "neon", category: "database" })).toBe("data");
    expect(pluginCategory({ name: "advisor", category: "developer-tools" })).toBe("code");
    expect(pluginCategory({ name: "something-new", category: "integrations" })).toBeNull();
    expect(pluginCategory({ name: "something-new", category: null })).toBeNull();
  });
});

describe("comparePlugins", () => {
  it("lists recommended brands first, then plugins with a logo and description", () => {
    const sorted = [
      entry({ name: "aardvark" }),
      entry({ name: "zebra", logo: "https://example.test/zebra.svg", description: "Zebras" }),
      entry({ name: "sentry" }),
      entry({ name: "github" }),
    ].sort(comparePlugins);
    expect(sorted.map((row) => row.name)).toEqual(["github", "sentry", "zebra", "aardvark"]);
  });
});

describe("matchesPluginQuery", () => {
  const calcom = entry({
    name: "calcom",
    displayName: "Calcom",
    description: "Cal.com scheduling integration",
    domains: ["cal.com"],
    category: "productivity",
  });
  it("matches the start of any word, including domains and the category label", () => {
    expect(matchesPluginQuery(calcom, "cal")).toBe(true);
    expect(matchesPluginQuery(calcom, "sched")).toBe(true);
    expect(matchesPluginQuery(calcom, "CALCOM")).toBe(true);
    expect(matchesPluginQuery(calcom, "work", "Productivity work")).toBe(true);
    expect(matchesPluginQuery(calcom, "")).toBe(true);
  });
  it("does not match the middle of a word", () => {
    expect(matchesPluginQuery(calcom, "endar")).toBe(false);
    expect(matchesPluginQuery(calcom, "cal invoices")).toBe(false);
  });
});

describe("matchesWordPrefixes", () => {
  it("matches word starts and joined names but not the middle of a word", () => {
    expect(matchesWordPrefixes("Google Calendar", "cal")).toBe(true);
    expect(matchesWordPrefixes("Google Calendar", "googlecal")).toBe(true);
    expect(matchesWordPrefixes("Tailscale", "cal")).toBe(false);
    expect(matchesWordPrefixes("Recall.ai", "cal")).toBe(false);
  });
});

describe("managedAppFor", () => {
  it("matches a plugin to the managed app of the same brand", () => {
    const apps = [
      { name: "Google Calendar", slug: "googlecalendar" },
      { name: "Vercel", slug: "VERCEL" },
    ];
    expect(managedAppFor(entry({ name: "vercel", displayName: "Vercel" }), apps)).toBe(apps[1]);
    expect(managedAppFor(entry({ name: "google-calendar" }), apps)).toBe(apps[0]);
    expect(managedAppFor(entry({ name: "calcom", displayName: "Calcom" }), apps)).toBeUndefined();
  });
});

describe("installedPluginParts", () => {
  it("reads chosen parts and treats older installs as complete", () => {
    expect(installedPluginParts({ parts: ["skills"] })).toEqual(["skills"]);
    expect(installedPluginParts({})).toEqual(["connector", "skills"]);
  });
});
