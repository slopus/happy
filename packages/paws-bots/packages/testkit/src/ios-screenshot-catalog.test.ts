import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadIosScreenshotCatalog } from "./ios-screenshot-catalog.js";

const mobileDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/mobile",
);
const catalogDir = path.join(mobileDir, "e2e", "ios-screenshots");

/** Screens the catalog cannot reach yet, and why. Capture one and remove it here. */
const UNCOVERED: Record<string, string> = {
  "integration-setup": "redirects to Integrations",
  share: "Android only: iOS has no share extension yet",
};

/** Route names under app/, without route groups, layouts, or Expo Router hooks. */
async function appRoutes(dir: string, prefix = ""): Promise<string[]> {
  const routes: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const group = /^\(.*\)$/.test(entry.name);
      routes.push(
        ...(await appRoutes(
          path.join(dir, entry.name),
          group ? prefix : `${prefix}${entry.name}/`,
        )),
      );
    } else if (/\.tsx$/.test(entry.name) && !/^[_+]/.test(entry.name)) {
      routes.push(`${prefix}${entry.name.replace(/\.tsx$/, "")}`);
    }
  }
  return routes;
}

describe("iOS screenshot catalog", () => {
  it("lists named sections whose flow files exist", async () => {
    const sections = await loadIosScreenshotCatalog(catalogDir);
    for (const section of sections) {
      await access(path.join(catalogDir, section.flow));
    }
  });

  it("captures every app screen or says why not", async () => {
    const routes = (await appRoutes(path.join(mobileDir, "app"))).sort();
    const captured = new Set(
      (await loadIosScreenshotCatalog(catalogDir)).flatMap((section) => section.screens),
    );
    expect(routes.filter((route) => !captured.has(route) && !UNCOVERED[route])).toEqual([]);
    expect(
      [...captured, ...Object.keys(UNCOVERED)].filter((route) => !routes.includes(route)),
    ).toEqual([]);
    expect(Object.keys(UNCOVERED).filter((route) => captured.has(route))).toEqual([]);
  });
});
