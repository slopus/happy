import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArchivedBuild } from "./asset-archive";
import {
  ASSET_ARCHIVE_GRACE_MS,
  ASSET_ARCHIVE_MAX_AGE_MS,
  ASSET_ARCHIVE_MAX_BUILDS,
  archiveAssets,
  planAssetPrune,
} from "./asset-archive";

const DAY = 24 * 60 * 60_000;
const NOW = 100 * DAY;

function build(id: string, startedAt: number, files: string[] = [`${id}.js`]): ArchivedBuild {
  return { id, files, startedAt };
}

describe("asset archive pruning", () => {
  it("keeps builds replaced within the age limit and the files they list", () => {
    const builds = [
      build("current", NOW, ["shared.js", "current.js"]),
      build("previous", NOW - 30 * DAY, ["shared.js", "previous.js"]),
      build("older", NOW - 40 * DAY, ["older.js"]),
    ];
    const files = ["shared.js", "current.js", "previous.js", "older.js", "orphan.js"];
    // "previous" was replaced just now, so it stays however long it ran; "older" was replaced 30
    // days ago, when "previous" started.
    expect(planAssetPrune(builds, files, "current", NOW)).toEqual({
      builds: ["older"],
      files: ["older.js", "orphan.js"],
    });
  });

  it("drops a build once a week has passed since a newer one replaced it", () => {
    const builds = [
      build("current", NOW),
      build("recent", NOW - ASSET_ARCHIVE_MAX_AGE_MS),
      build("stale", NOW - ASSET_ARCHIVE_MAX_AGE_MS - 1),
    ];
    expect(planAssetPrune(builds, [], "current", NOW).builds).toEqual([]);
    expect(planAssetPrune(builds, [], "current", NOW + 1).builds).toEqual(["stale"]);
  });

  it("caps the number of builds kept, newest first", () => {
    const builds = Array.from({ length: ASSET_ARCHIVE_MAX_BUILDS + 3 }, (_, index) =>
      build(`b${index}`, NOW - index * 60_000),
    );
    expect(planAssetPrune(builds, [], "b0", NOW).builds).toEqual(["b20", "b21", "b22"]);
  });
});

describe("asset archive", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function deploy(root: string, buildId: string, files: Record<string, string>, now: number) {
    const assetsDir = path.join(root, buildId);
    fs.mkdirSync(assetsDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(assetsDir, name), content);
    }
    return archiveAssets({ assetsDir, archiveDir: path.join(root, "archive"), buildId, now });
  }

  it("stays off when the archive directory does not exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-archive-"));
    roots.push(root);
    expect(deploy(root, "20261001000000", { "a.js": "a" }, NOW)).toBeNull();
    expect(fs.existsSync(path.join(root, "archive"))).toBe(false);
  });

  it("serves earlier builds' chunks beside the current one and prunes the expired", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-archive-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "archive"));

    const archived = deploy(root, "20261001000000", { "old-a.js": "a", "shared.js": "s" }, 0);
    deploy(root, "20261002000000", { "mid.js": "m", "shared.js": "s" }, DAY);
    expect(fs.readdirSync(archived!).sort()).toEqual(["mid.js", "old-a.js", "shared.js"]);

    // The first build was replaced on day 1, so it expires a week later.
    deploy(root, "20261003000000", { "new.js": "n" }, DAY + ASSET_ARCHIVE_MAX_AGE_MS + 1);
    expect(fs.readdirSync(archived!).sort()).toEqual(["mid.js", "new.js", "shared.js"]);
    expect(fs.readFileSync(path.join(archived!, "shared.js"), "utf8")).toBe("s");
    expect(fs.readdirSync(path.join(root, "archive", "builds")).sort()).toEqual([
      "20261002000000.json",
      "20261003000000.json",
    ]);
  });

  it("leaves files another container just touched while its build list may not be visible yet", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-archive-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "archive", "assets"), { recursive: true });
    const racing = path.join(root, "archive", "assets", "racing.js");
    fs.writeFileSync(racing, "r");
    const touched = new Date(NOW - ASSET_ARCHIVE_GRACE_MS + 60_000);
    fs.utimesSync(racing, touched, touched);

    const archived = deploy(root, "20261003000000", { "new.js": "n" }, NOW);
    expect(fs.readdirSync(archived!).sort()).toEqual(["new.js", "racing.js"]);
    deploy(root, "20261003000000", { "new.js": "n" }, NOW + 2 * ASSET_ARCHIVE_GRACE_MS);
    expect(fs.readdirSync(archived!)).toEqual(["new.js"]);
  });
});
