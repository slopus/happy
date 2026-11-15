import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const OWNER_URL = "postgres://owner:fake-owner-password@postgres:5432/rakazo";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

/**
 * Runs the Railway start script with fake pnpm and node. Each pnpm call logs whether it, and
 * on Linux the shell that started it, still holds the owner login.
 */
function start(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-railway-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  write(
    path.join(bin, "pnpm"),
    `#!/bin/bash
owner=no; [[ -n "\${DATABASE_MIGRATION_URL:-}" ]] && owner=yes
parent=unknown
if [[ -r /proc/$PPID/environ ]]; then
  parent=no
  tr '\\0' '\\n' < /proc/$PPID/environ | grep -q '^DATABASE_MIGRATION_URL=' && parent=yes
fi
echo "pnpm $* owner=$owner parent=$parent" >> "$COMMAND_LOG"
[[ "$*" == *db:deploy* && -n "\${FAIL_MIGRATE:-}" ]] && exit 1
exit 0
`,
  );
  write(path.join(bin, "node"), "#!/bin/bash\necho test-environment\n");
  const result = spawnSync("/bin/bash", [path.join(repoRoot, "infra/railway/start.sh")], {
    cwd: root,
    env: {
      PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
      HOME: root,
      COMMAND_LOG: log,
      DATABASE_MIGRATION_URL: OWNER_URL,
      DATABASE_URL: "postgres://app:fake-app-password@postgres:5432/rakazo",
      ...overrides,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { result, lines };
}

// The script drops to the node user with gosu when started as root.
describe.skipIf(process.getuid?.() === 0)("Railway start script", () => {
  it("migrates once with the owner login, then serves from a shell without it", () => {
    const { lines } = start();
    const migrations = lines.filter((line) => line.includes(" db:deploy "));
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toContain("owner=yes");
    const serving = lines.filter((line) => !line.includes(" db:deploy "));
    expect(serving.some((line) => line.includes("bootstrap-owner.js"))).toBe(true);
    for (const line of serving) {
      expect(line).toContain("owner=no");
      expect(line).not.toContain("parent=yes");
    }
  });

  it("serves nothing when migrations fail", () => {
    const { result, lines } = start({ FAIL_MIGRATE: "1" });
    expect(result.status).not.toBe(0);
    expect(lines).toEqual([expect.stringContaining(" db:deploy owner=yes")]);
  });
});
