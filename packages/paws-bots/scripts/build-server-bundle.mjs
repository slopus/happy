#!/usr/bin/env node
// Packs the API, worker, web server and migrations into one archive that runs on plain Node, or
// on Electron's binary with ELECTRON_RUN_AS_NODE=1, for hosts that run Rakazo without containers.
// Usage: build-server-bundle.mjs <out-dir> [download-base-url]
// Needs `pnpm db:generate` and `pnpm --filter @rakazo/web build` first. Writes
// rakazo-server-<platform>-<arch>-<version>.tar.xz and server-bundle.json { url, sha256, size,
// version } to <out-dir>; the url is the base joined with the archive's name.
//
// The archive holds one folder, rakazo-server/, laid out like the repository so the paths
// build-server.mjs writes into node_modules/.pnpm resolve unchanged: built entrypoints, the web
// app, the database package's schema and migrations, and production dependencies for this
// platform only. manifest.json names each entrypoint relative to that folder. Run each with that
// folder as the working directory, the same environment as the Compose service of the same name:
//   migrate  DATABASE_URL, DATABASE_MIGRATION_URL, RAKAZO_DB_PACKAGE_DIR=packages/db
//   api      DATABASE_URL, API_HOST, API_PORT, BETTER_AUTH_SECRET, BETTER_AUTH_URL, WEB_ORIGIN,
//            SCREEN_PROXY_SECRET, DATA_DIR, SANDBOX_PROVIDER (and that provider's settings,
//            such as LOCAL_VM_CLI), RAKAZO_DESKTOP_STACK_TOKEN
//   worker   DATABASE_URL, DATA_DIR, SANDBOX_PROVIDER (and that provider's settings)
//   web      API_PROXY_TARGET, SCREEN_PROXY_SECRET, WEB_HOST (127.0.0.1), WEB_PORT (5173),
//            RAKAZO_HOST, RAKAZO_DESKTOP_STACK_TOKEN, RAKAZO_IMAGE_TAG
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { serverBuildOptions } from "./build-server.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const store = path.join(repo, "node_modules", ".pnpm");
const [outArg, downloadBase] = process.argv.slice(2);
if (!outArg) throw new Error("Usage: build-server-bundle.mjs <out-dir> [download-base-url]");
const outDir = path.resolve(outArg);

const ENTRYPOINTS = {
  api: ["apps/api/src/index.ts", "apps/api/dist/index.js"],
  worker: ["apps/worker/src/index.ts", "apps/worker/dist/index.js"],
  web: ["apps/web/src/standalone-server.ts", "apps/web/dist-server/index.js"],
  migrate: ["apps/api/src/cli/migrate-database.ts", "apps/api/dist/cli/migrate-database.js"],
};
// Their production dependencies are what the bundled code may load at runtime, for example the
// page runtime build, mermaid, and the Prisma CLI that applies migrations.
const SERVER_WORKSPACES = ["apps/api", "apps/worker"];
// Read from disk at runtime, outside any package: the computer image's page-browser scripts.
const EXTRA_PATHS = ["infra/sandboxes/computer"];

for (const required of ["apps/web/dist/index.html", "packages/db/src/generated"]) {
  if (!fs.existsSync(path.join(repo, required))) {
    throw new Error(`${required} is missing; generate the database client and build the web app.`);
  }
}

const version = JSON.parse(
  fs.readFileSync(path.join(repo, "apps/desktop/package.json"), "utf8"),
).version;
const name = `rakazo-server-${process.platform}-${process.arch}-${version}`;
const work = fs.mkdtempSync(path.join(tmpdir(), "rakazo-server-bundle-"));
const stage = path.join(work, "rakazo-server");
const staged = (file) => path.join(stage, path.relative(repo, file));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Source maps and type declarations, which Node never loads, and the query engines for the
// databases the schema does not use.
const UNUSED_AT_RUNTIME =
  /\.map$|\.d\.[cm]?ts$|[\\/]@prisma[\\/]client[\\/]runtime[\\/]query_compiler_.*\.(?:cockroachdb|mysql|sqlite|sqlserver)\./;

function copy(from, to = staged(from)) {
  fs.cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !UNUSED_AT_RUNTIME.test(source),
  });
}

function link(at) {
  const target = fs.readlinkSync(at);
  fs.mkdirSync(path.dirname(staged(at)), { recursive: true });
  if (!fs.existsSync(staged(at))) fs.symlinkSync(target, staged(at));
}

/** Whether an installed package targets this machine; pnpm installs both macOS architectures. */
function runsHere(manifest) {
  const allowed = (list, value) => {
    if (!list?.length || list.includes(`!${value}`)) return !list?.length;
    const only = list.filter((entry) => !entry.startsWith("!"));
    return only.length === 0 || only.includes(value);
  };
  return allowed(manifest.os, process.platform) && allowed(manifest.cpu, process.arch);
}

// Optional peers stay out: packages list test runners and bundlers there that a server never loads.
const productionDependencies = (manifest) => [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) => !manifest.peerDependenciesMeta?.[name]?.optional,
  ),
];

// Third-party packages: each one's folder in the store, the links to its dependencies beside it,
// and its entry in the store's hoisted folder, which pnpm resolves undeclared imports through.
const packages = new Set();
function addPackage(packageDir) {
  const real = fs.realpathSync(packageDir);
  if (!real.startsWith(store + path.sep)) throw new Error(`${packageDir} is outside the store`);
  if (packages.has(real)) return;
  const manifest = readJson(path.join(real, "package.json"));
  if (!runsHere(manifest)) return;
  packages.add(real);
  copy(real);
  const hoisted = path.join(store, "node_modules", manifest.name);
  if (fs.existsSync(hoisted) && fs.realpathSync(hoisted) === real) link(hoisted);
  const siblings = path.join(real, ...manifest.name.split("/").map(() => ".."));
  for (const dependency of productionDependencies(manifest)) {
    const at = path.join(siblings, dependency);
    if (!fs.existsSync(at) || !fs.lstatSync(at).isSymbolicLink()) continue;
    if (!runsHere(readJson(path.join(at, "package.json")))) continue;
    link(at);
    addPackage(at);
  }
}

/** The package folder a resolved file belongs to. */
function packageOf(file) {
  const parts = path.relative(store, file).split(path.sep);
  const nameLength = parts[2]?.startsWith("@") ? 2 : 1;
  return path.join(store, ...parts.slice(0, 2 + nameLength));
}

// Workspace packages the server reaches: manifests, sources and production dependency links.
const workspaces = new Set();
function addWorkspace(dir) {
  if (workspaces.has(dir)) return;
  workspaces.add(dir);
  const manifest = readJson(path.join(repo, dir, "package.json"));
  const tracked = execFileSync("git", ["ls-files", "-z", "--", dir], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && !/\.test\.[cm]?tsx?$|\/src\/.*\.(?:e2e|eval)\./.test(file));
  for (const file of dir.startsWith("apps/") ? [`${dir}/package.json`] : tracked) {
    copy(path.join(repo, file));
  }
  for (const dependency of productionDependencies(manifest)) {
    const at = path.join(repo, dir, "node_modules", dependency);
    if (!fs.existsSync(at)) continue;
    link(at);
    const real = fs.realpathSync(at);
    if (real.startsWith(store + path.sep)) addPackage(real);
    else addWorkspace(path.relative(repo, real));
  }
}

const started = Date.now();
fs.mkdirSync(stage, { recursive: true });
for (const [source, output] of Object.values(ENTRYPOINTS)) {
  const outfile = path.join(repo, output);
  const result = await build({
    ...serverBuildOptions(path.join(repo, source), outfile),
    sourcemap: false,
    write: false,
    metafile: true,
  });
  for (const file of result.outputFiles) {
    fs.mkdirSync(path.dirname(staged(file.path)), { recursive: true });
    fs.writeFileSync(staged(file.path), file.contents);
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const entry of output.imports) {
      if (!entry.external || !entry.path.startsWith(".")) continue;
      addPackage(packageOf(path.resolve(path.dirname(outfile), entry.path)));
    }
  }
}
for (const dir of SERVER_WORKSPACES) addWorkspace(dir);
copy(path.join(repo, "apps/web/package.json"));
copy(path.join(repo, "apps/web/dist"));
for (const extra of EXTRA_PATHS) copy(path.join(repo, extra));

const entrypoints = Object.fromEntries(
  Object.entries(ENTRYPOINTS).map(([key, [, output]]) => [key, output]),
);
fs.writeFileSync(
  path.join(stage, "manifest.json"),
  `${JSON.stringify({ version, entrypoints }, null, 2)}\n`,
);

fs.mkdirSync(outDir, { recursive: true });
const archive = path.join(outDir, `${name}.tar.xz`);
fs.rmSync(archive, { force: true });
execFileSync("tar", ["-C", work, "-cJf", archive, "rakazo-server"], { stdio: "inherit" });
fs.rmSync(work, { recursive: true, force: true });

const sha256 = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
const size = fs.statSync(archive).size;
const descriptor = {
  url: downloadBase ? `${downloadBase.replace(/\/$/, "")}/${path.basename(archive)}` : null,
  sha256,
  size,
  version,
};
fs.writeFileSync(
  path.join(outDir, "server-bundle.json"),
  `${JSON.stringify(descriptor, null, 2)}\n`,
);
process.stdout.write(
  `${path.basename(archive)}: ${(size / 1e6).toFixed(1)} MB, ${packages.size} packages, ${((Date.now() - started) / 1000).toFixed(0)}s\n`,
);
