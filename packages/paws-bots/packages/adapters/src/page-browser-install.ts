import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { shellQuote } from "./computer-support.js";

/** The computer image's page-browser files: the API ships them in its source tree. */
const COMPUTER_DIR = path.join("infra", "sandboxes", "computer");

let computerDir: string | undefined;

function computerFile(name: string): string {
  if (!computerDir) {
    // Source, tests and the bundled server all sit somewhere below the repository root.
    for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, COMPUTER_DIR);
      if (existsSync(path.join(candidate, "rakazo-page-browser"))) {
        computerDir = candidate;
        break;
      }
      if (path.dirname(dir) === dir) throw new Error(`${COMPUTER_DIR} is missing`);
    }
  }
  return readFileSync(path.join(computerDir, name), "utf8");
}

const asRoot = 'if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi';

/**
 * Installs the pinned agent-browser into /usr/local/bin with the computer image's own script.
 * It changes only when the pinned version does, so a provider's saved base image can carry it.
 */
export function installChromeUseCommand(): string {
  return [
    "set -eu",
    asRoot,
    `$root sh -c ${shellQuote(computerFile("install-chrome-use.sh"))} sh /usr/local/bin >/dev/null`,
  ].join("\n");
}

/**
 * Writes the page-browser wrapper and its secrets helper where the computer image keeps them,
 * from this release's copy, unless they already match it. Small enough to run on every boot,
 * so a hosted computer always runs the helper its API was released with.
 */
export function installPageBrowserFilesCommand(): string {
  const wrapper = computerFile("rakazo-page-browser");
  const secrets = computerFile("page_secrets.py");
  const version = createHash("sha256").update(wrapper).update("\0").update(secrets).digest("hex");
  // One archive, so both files change together.
  const archive = gzipSync(
    JSON.stringify({ "rakazo-page-browser": wrapper, "page_secrets.py": secrets }),
    { level: 9 },
  ).toString("base64");
  const unpack = [
    "import gzip, json, os, sys",
    "files = json.loads(gzip.decompress(sys.stdin.buffer.read()))",
    "os.makedirs('/usr/local/lib/rakazo', exist_ok=True)",
    "for name, mode, target in (('page_secrets.py', 0o644, '/usr/local/lib/rakazo/page_secrets.py'),",
    "                           ('rakazo-page-browser', 0o755, '/usr/local/bin/rakazo-page-browser')):",
    "    with open(target + '.new', 'w', encoding='utf-8') as file:",
    "        file.write(files[name])",
    "    os.chmod(target + '.new', mode)",
    "    os.replace(target + '.new', target)",
    `open('/usr/local/lib/rakazo/page-browser.version', 'w').write(${JSON.stringify(version)})`,
  ].join("\n");
  return [
    "set -eu",
    `if [ "$(cat /usr/local/lib/rakazo/page-browser.version 2>/dev/null)" = ${version} ]; then exit 0; fi`,
    asRoot,
    `printf '%s' ${shellQuote(archive)} | base64 -d | $root python3 -c ${shellQuote(unpack)}`,
  ].join("\n");
}

/** Everything a hosted Linux computer needs for the page tools; idempotent and cheap once done. */
export function installPageBrowserCommand(): string {
  return [installChromeUseCommand(), installPageBrowserFilesCommand()]
    .map((script) => `( ${script}\n)`)
    .join(" && ");
}
