import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Under the web app's root. The container images create it and Compose mounts a volume there. */
export const ASSET_ARCHIVE_DIR = "asset-archive";
/** How long a build's assets stay after a newer build replaced it, for tabs still running it. */
export const ASSET_ARCHIVE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Builds kept at most, the current one included, however recent. */
export const ASSET_ARCHIVE_MAX_BUILDS = 20;
/**
 * Every start touches the files it serves; a file touched this recently is never pruned, so a
 * prune racing another container's start cannot delete what that container just listed.
 */
export const ASSET_ARCHIVE_GRACE_MS = 60 * 60_000;

export type ArchivedBuild = { id: string; files: readonly string[]; startedAt: number };

/**
 * Which archived builds and files to delete. The current build stays, and so does each newer-first
 * build replaced within the age limit (it was replaced when the next newer build started), up to
 * the count limit. A file goes only when no kept build lists it.
 */
export function planAssetPrune(
  builds: readonly ArchivedBuild[],
  files: readonly string[],
  current: string,
  now: number,
): { builds: string[]; files: string[] } {
  const newestFirst = [...builds].sort((a, b) => b.startedAt - a.startedAt);
  const kept = new Set([current]);
  for (const [index, build] of newestFirst.entries()) {
    if (kept.size >= ASSET_ARCHIVE_MAX_BUILDS) break;
    const replacedAt = newestFirst[index - 1]?.startedAt ?? now;
    if (now - replacedAt <= ASSET_ARCHIVE_MAX_AGE_MS) kept.add(build.id);
  }
  const needed = new Set(
    builds.filter((build) => kept.has(build.id)).flatMap((build) => build.files),
  );
  return {
    builds: builds.filter((build) => !kept.has(build.id)).map((build) => build.id),
    files: files.filter((file) => !needed.has(file)),
  };
}

function readBuild(file: string): ArchivedBuild | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ArchivedBuild>;
    if (!Array.isArray(value.files) || typeof value.startedAt !== "number") return null;
    return {
      id: path.basename(file, ".json"),
      files: value.files.filter((name) => typeof name === "string"),
      startedAt: value.startedAt,
    };
  } catch {
    return null;
  }
}

function recentlyTouched(file: string, now: number): boolean {
  try {
    return now - fs.statSync(file).mtimeMs <= ASSET_ARCHIVE_GRACE_MS;
  } catch {
    // Already gone.
    return true;
  }
}

function writeAtomically(target: string, write: (temporary: string) => void) {
  const temporary = path.join(path.dirname(target), `.tmp-${randomUUID()}`);
  try {
    write(temporary);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Adds this build's hashed assets to the shared archive and prunes builds nobody runs any more, so
 * a tab still on a previous deploy (or a request a rolling deploy routes to the other container)
 * finds its chunks. Off unless the archive directory exists, which only the container images
 * create. Returns the archive's assets directory when on.
 */
export function archiveAssets(options: {
  assetsDir: string;
  archiveDir: string;
  buildId: string;
  now: number;
}): string | null {
  const { assetsDir, archiveDir, buildId, now } = options;
  if (!buildId || !fs.existsSync(archiveDir)) return null;
  const archivedAssets = path.join(archiveDir, "assets");
  const buildsDir = path.join(archiveDir, "builds");
  fs.mkdirSync(archivedAssets, { recursive: true });
  fs.mkdirSync(buildsDir, { recursive: true });

  const files = fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  writeAtomically(path.join(buildsDir, `${buildId}.json`), (temporary) =>
    fs.writeFileSync(temporary, JSON.stringify({ files, startedAt: now })),
  );
  const touched = new Date(now);
  for (const file of files) {
    const target = path.join(archivedAssets, file);
    // Hashed names: an archived file with the same name has the same content. Touching it fails
    // when it is missing, including when a racing prune removed it a moment ago; copy it then.
    try {
      fs.utimesSync(target, touched, touched);
    } catch {
      writeAtomically(target, (temporary) => {
        fs.copyFileSync(path.join(assetsDir, file), temporary);
        fs.utimesSync(temporary, touched, touched);
      });
    }
  }

  const builds = fs
    .readdirSync(buildsDir)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        readBuild(path.join(buildsDir, name)) ?? {
          id: path.basename(name, ".json"),
          files: [],
          startedAt: 0,
        },
    );
  const archived = fs
    .readdirSync(archivedAssets)
    .filter(
      (name) => !name.startsWith(".tmp-") && !recentlyTouched(path.join(archivedAssets, name), now),
    );
  const prune = planAssetPrune(builds, archived, buildId, now);
  for (const id of prune.builds) fs.rmSync(path.join(buildsDir, `${id}.json`), { force: true });
  for (const file of prune.files) fs.rmSync(path.join(archivedAssets, file), { force: true });
  return archivedAssets;
}
