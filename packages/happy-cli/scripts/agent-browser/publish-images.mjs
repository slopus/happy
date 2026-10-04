#!/usr/bin/env node
// publish-images — build the Agent Browser runtime and browser images for linux/amd64 and linux/arm64, push them to a
// registry and write abp-images.json, the digests a machine pulls them by (abp-stack pull, abp-install --images-manifest).
// Run by the happy-cli release workflow before npm publish. Saydo specs/agent-browser-one-click-install I5.
//
//   node publish-images.mjs --repo <docker hub namespace> --version <release> --out <abp-images.json>
//
// The image id a machine sees after `docker pull` (classic image store) is the platform manifest's config digest, so
// that is what abp-images.json records per architecture, next to the pinned multi-arch reference.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { imageContextFiles } from "./lib/abpPlan.mjs";

const ARCHITECTURES = ["amd64", "arm64"];
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Image id per architecture: the config digest of each linux platform manifest listed in the multi-arch index. */
export function configDigests(indexRaw, fetchManifestRaw) {
  const index = JSON.parse(indexRaw);
  const ids = {};
  for (const arch of ARCHITECTURES) {
    const entry = (index.manifests ?? []).find((m) => m.platform?.os === "linux" && m.platform?.architecture === arch);
    if (!entry) throw new Error(`no ${arch} image in the pushed index`);
    const config = JSON.parse(fetchManifestRaw(entry.digest)).config?.digest;
    if (!DIGEST.test(config ?? "")) throw new Error(`${arch} manifest has no config digest`);
    ids[arch] = config;
  }
  return ids;
}

/** abp-images.json: what abp-stack pull checks before accepting the images. */
export function imagesManifest({ version, runtime, browser }) {
  for (const [role, image] of [["runtime", runtime], ["browser", browser]]) {
    if (typeof image?.ref !== "string" || !/@sha256:[0-9a-f]{64}$/.test(image.ref)) throw new Error(`${role} reference must be pinned by digest`);
    for (const arch of ARCHITECTURES) if (!DIGEST.test(image.ids?.[arch] ?? "")) throw new Error(`${role} image id for ${arch} is missing`);
  }
  return { schemaVersion: 1, version, runtime, browser };
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} … failed (${result.status})`);
  return result.stdout.trim();
}

function main(argv) {
  const option = (name) => { const i = argv.indexOf(name); if (i < 0 || !argv[i + 1]) throw new Error(`${name} is required`); return argv[i + 1]; };
  const repo = option("--repo"), version = option("--version"), out = resolve(option("--out"));
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const staging = mkdtempSync(join(tmpdir(), "abp-publish-"));
  try {
    sh(process.execPath, [join(packageDir, "scripts/browser-poc/build-runtime.mjs"), join(staging, "runtime.mjs")], { stdio: "inherit" });
    for (const [from, name] of imageContextFiles(packageDir)) copyFileSync(from, join(staging, name));
    const images = {};
    for (const role of ["runtime", "browser"]) {
      const name = `docker.io/${repo}/abp-${role}`;
      const metadata = join(staging, `${role}.metadata.json`);
      sh("docker", ["buildx", "build", "--platform", ARCHITECTURES.map((a) => `linux/${a}`).join(","), "--provenance=false", "--sbom=false",
        "-f", join(staging, `${role}.Dockerfile`), "-t", `${name}:${version}`, "--metadata-file", metadata, "--push", staging], { stdio: "inherit" });
      const indexDigest = JSON.parse(readFileSync(metadata, "utf8"))["containerimage.digest"];
      if (!DIGEST.test(indexDigest ?? "")) throw new Error(`${role}: buildx reported no image digest`);
      const ref = `${name}@${indexDigest}`;
      const ids = configDigests(sh("docker", ["buildx", "imagetools", "inspect", "--raw", ref]),
        (digest) => sh("docker", ["buildx", "imagetools", "inspect", "--raw", `${name}@${digest}`]));
      images[role] = { ref, ids };
    }
    writeFileSync(out, `${JSON.stringify(imagesManifest({ version, ...images }), null, 2)}\n`, { mode: 0o644 });
    console.log(`wrote ${out}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`publish-images: ${error.message}`); process.exit(1); }
}
