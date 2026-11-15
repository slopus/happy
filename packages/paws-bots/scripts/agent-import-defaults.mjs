#!/usr/bin/env node
/**
 * Rebuilds the default-file table in packages/core/src/agent-import/stock.ts.
 *
 *   node scripts/agent-import-defaults.mjs <openclaw-checkout> <hermes-agent-checkout>
 *
 * - OpenClaw: every committed version of docs/reference/templates/{SOUL,AGENTS,USER,
 *   IDENTITY}.md. The checkout needs its full history (`git clone` without `--depth`); a
 *   shallow one is refused, as it would silently miss versions.
 * - Hermes Agent: the texts `hermes_cli/default_soul.py` treats as untouched defaults
 *   (`DEFAULT_SOUL_MD` and `_LEGACY_TEMPLATE_SOULS`), from the file as committed at HEAD
 *   (`git show`, never the working copy), evaluated with python3.
 *
 * Offline: only local files, git and python3. `fingerprint()` must match stock.ts.
 */
import { execFileSync } from "node:child_process";

const [openclaw, hermes] = process.argv.slice(2);
if (!openclaw || !hermes) {
  console.error("usage: agent-import-defaults.mjs <openclaw-checkout> <hermes-agent-checkout>");
  process.exit(1);
}

function fingerprint(content) {
  const text = content
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .trim();
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${bytes.length}`;
}

function withoutFrontmatter(content) {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

const git = (checkout, ...args) =>
  execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" });

if (git(openclaw, "rev-parse", "--is-shallow-repository").trim() !== "false") {
  throw new Error(`${openclaw} is a shallow clone: fetch its full history first`);
}

const lines = [];
for (const name of ["SOUL", "AGENTS", "USER", "IDENTITY"]) {
  const file = `docs/reference/templates/${name}.md`;
  // Each commit that touched the file, with the path it had then (renames followed).
  const log = git(openclaw, "log", "--follow", "--format=%H", "--name-only", "--", file)
    .split("\n")
    .filter(Boolean);
  if (log.length === 0 || log.length % 2 !== 0) throw new Error(`unexpected git log for ${file}`);
  const versions = new Map();
  for (let index = 0; index < log.length; index += 2) {
    const [sha, path] = [log[index], log[index + 1]];
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected commit "${sha}" for ${file}`);
    const content = git(openclaw, "show", `${sha}:${path}`);
    if (!content.trim()) continue;
    const key = fingerprint(withoutFrontmatter(content));
    versions.set(key, [...(versions.get(key) ?? []), sha].sort());
  }
  lines.push(`  "${name}.md": versions([`);
  for (const key of [...versions.keys()].sort()) {
    lines.push(`    "${key}", // ${versions.get(key).join(" ")}`);
  }
  lines.push("  ]),");
}

const head = git(hermes, "rev-parse", "HEAD").trim();
// The committed file at HEAD, not the working copy, so the recorded commit is what was hashed.
const source = git(hermes, "show", `${head}:hermes_cli/default_soul.py`);
const texts = JSON.parse(
  execFileSync(
    "python3",
    [
      "-c",
      [
        "import json, sys",
        "namespace = {}",
        "exec(compile(sys.stdin.read(), 'default_soul.py', 'exec'), namespace)",
        "print(json.dumps([namespace['DEFAULT_SOUL_MD'], *namespace['_LEGACY_TEMPLATE_SOULS']]))",
      ].join("\n"),
    ],
    { encoding: "utf8", input: source },
  ),
);
lines.push(`// Hermes Agent hermes_cli/default_soul.py at ${head}`);
for (const key of [...new Set(texts.map(fingerprint))].sort()) lines.push(`"${key}",`);
console.log(lines.join("\n"));
