import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultMcpPackagesRoot,
  ensureMcpPackage,
  isInstalledMcpBin,
  mcpPackageDir,
  parseNpxLaunch,
  registryPackageName,
} from "./mcp-package-installer.js";

vi.mock("node:fs/promises", { spy: true });

describe("parseNpxLaunch", () => {
  it("reads the plain and -y forms", () => {
    expect(parseNpxLaunch("npx", ["-y", "@klodr/gmail-mcp@2.0.2"])).toEqual({
      spec: "@klodr/gmail-mcp@2.0.2",
      binArgs: [],
    });
    expect(parseNpxLaunch("npx", ["--yes", "server-pkg", "--port", "1", "-y"])).toEqual({
      spec: "server-pkg",
      binArgs: ["--port", "1", "-y"],
    });
    expect(parseNpxLaunch("/usr/local/bin/npx", ["pkg@latest"])).toEqual({
      spec: "pkg@latest",
      binArgs: [],
    });
    expect(parseNpxLaunch("npx", ["-y", "--", "pkg@^1.2.0", "a"])).toEqual({
      spec: "pkg@^1.2.0",
      binArgs: ["a"],
    });
  });

  it("reads -p/--package with the bin named next", () => {
    expect(parseNpxLaunch("npx", ["-y", "-p", "@scope/tools@1.0.0", "tool-a", "x"])).toEqual({
      spec: "@scope/tools@1.0.0",
      binName: "tool-a",
      binArgs: ["x"],
    });
    expect(parseNpxLaunch("npx", ["--package=tools", "--", "tool-b"])).toEqual({
      spec: "tools",
      binName: "tool-b",
      binArgs: [],
    });
    expect(parseNpxLaunch("npx", ["--package", "tools", "tool-c"])).toMatchObject({
      binName: "tool-c",
    });
  });

  it("leaves everything else to a plain launch", () => {
    for (const [command, args] of [
      ["node", ["server.js"]],
      ["npx", []],
      ["npx", ["-y"]],
      ["npx", ["--registry", "https://registry.example.test", "pkg"]],
      ["npx", ["-c", "echo hi"]],
      ["npx", ["-p", "a", "-p", "b", "bin"]],
      ["npx", ["-p", "pkg"]],
      ["npx", ["-p", "pkg", "../bin"]],
      ["npx", ["./local-server"]],
      ["npx", ["/abs/server"]],
      ["npx", ["github:owner/repo"]],
      ["npx", ["owner/repo"]],
      ["npx", ["git+https://example.test/repo.git"]],
      ["npx", ["https://example.test/pkg.tgz"]],
      ["npx", ["pkg.tgz"]],
      ["npx", ["alias@npm:pkg@1"]],
      ["npx", ["file:../pkg"]],
      ["npx", ["pkg@1.0.0 || evil"]],
    ] as const) {
      expect(parseNpxLaunch(command, [...args]), `${command} ${args.join(" ")}`).toBeUndefined();
    }
  });

  it("splits scoped and unscoped specs", () => {
    expect(registryPackageName("@a/b@1")).toBe("@a/b");
    expect(registryPackageName("@a/b")).toBe("@a/b");
    expect(registryPackageName("b@next")).toBe("b");
    expect(registryPackageName("b@")).toBeUndefined();
    expect(registryPackageName("@a")).toBeUndefined();
  });
});

describe("defaultMcpPackagesRoot", () => {
  it("prefers MCP_PACKAGES_DIR, then a writable DATA_DIR, then the temp dir", async () => {
    const data = await mkdtemp(join(tmpdir(), "rakazo-data-"));
    try {
      expect(defaultMcpPackagesRoot({ MCP_PACKAGES_DIR: "/srv/pkgs", DATA_DIR: data })).toBe(
        "/srv/pkgs",
      );
      expect(defaultMcpPackagesRoot({ DATA_DIR: data })).toBe(join(data, "mcp-packages"));
      expect(defaultMcpPackagesRoot({ DATA_DIR: join(data, "missing") })).toBe(
        join(tmpdir(), "rakazo-mcp-packages"),
      );
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});

/**
 * A stand-in for npm: installs `<name>` from the last argument into `--prefix`, logging each
 * run, and refuses an install that would run package scripts. NPM_CONFIG_FAKE_MODE=hang
 * writes half a package and never exits; fail exits 1 with output.
 */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.env.API_KEY) throw new Error("server secret leaked to npm");
const args = process.argv.slice(2);
if (!args.includes("--ignore-scripts")) { console.error("npm install would run package scripts"); process.exit(1); }
const prefix = args[args.indexOf("--prefix") + 1];
const target = args.at(-1);
const name = target.startsWith("@") ? "@" + target.slice(1).split("@")[0] : target.split("@")[0];
if (process.env.NPM_CONFIG_FAKE_LOG) fs.appendFileSync(process.env.NPM_CONFIG_FAKE_LOG, target + "\\n");
const dir = path.join(prefix, "node_modules", ...name.split("/"));
fs.mkdirSync(dir, { recursive: true });
const mode = process.env.NPM_CONFIG_FAKE_MODE || "ok";
const bin = JSON.parse(process.env.NPM_CONFIG_FAKE_BIN || '{"server":"bin/server.js"}');
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", bin }));
if (mode === "hang") { setInterval(() => {}, 1000); return; }
if (mode === "fail") { console.error("npm ERR! 404 Not Found - " + name); process.exit(1); }
const delay = Number(process.env.NPM_CONFIG_FAKE_DELAY_MS || 0);
setTimeout(() => {
  for (const file of new Set(typeof bin === "string" ? [bin] : Object.values(bin))) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "#!/usr/bin/env node\\nconsole.log('ran " + name + "');\\n");
  }
}, delay);
`;

describe("ensureMcpPackage", () => {
  let work: string;
  let root: string;
  let npm: string;
  let log: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "rakazo-mcp-installer-"));
    root = join(work, "packages");
    npm = join(work, "fake-npm");
    log = join(work, "npm.log");
    await writeFile(npm, FAKE_NPM);
    await chmod(npm, 0o755);
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  // Generous waits: under a loaded parallel run the stub npm install can take seconds.
  const WAIT = { timeout: 15_000, interval: 50 };

  it("preserves a fresh owner replacing the inspected expired lock", async () => {
    const lock = `${mcpPackageDir("race-pkg", root, options().env)}.lock`;
    await mkdir(lock, { recursive: true });
    const expired = { token: "expired", expiresAt: 0, pid: process.pid, host: hostname() };
    const fresh = { ...expired, token: "fresh", expiresAt: Date.now() + 60_000 };
    await writeFile(join(lock, "owner"), JSON.stringify(expired));
    const original = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === lock) {
        await writeFile(join(lock, "owner"), JSON.stringify(fresh));
      }
      return original(from, to);
    });
    const controller = new AbortController();
    const pending = ensureMcpPackage("race-pkg", { ...options(), signal: controller.signal });
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalled(), WAIT);
      await vi.waitFor(
        async () => expect(JSON.parse(await readFile(join(lock, "owner"), "utf8"))).toEqual(fresh),
        WAIT,
      );
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(await runs()).toEqual([]);
    } finally {
      spy.mockImplementation(original);
      await rm(lock, { recursive: true, force: true });
      // Let the shared install finish before deleting its fixture.
      await vi.waitFor(async () => expect(await runs()).toHaveLength(1), WAIT);
      await vi.waitFor(async () => expect(await leftovers()).toEqual([]), WAIT);
    }
  }, 30_000);

  const runs = async () =>
    existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean) : [];
  const leftovers = async () =>
    (await readdir(root)).filter((entry) => entry.startsWith(".tmp-") || entry.endsWith(".lock"));
  const options = (env: Record<string, string> = {}) => ({
    root,
    npmCommand: npm,
    env: { NPM_CONFIG_FAKE_LOG: log, ...env },
  });

  it("isolates registry settings and excludes server credentials from install scripts", async () => {
    const first = await ensureMcpPackage(
      "server@1",
      options({ npm_config_registry: "https://one.example.test", API_KEY: "fake-api-secret" }),
    );
    const second = await ensureMcpPackage(
      "server@1",
      options({ npm_config_registry: "https://two.example.test" }),
    );
    expect(first.binPath).not.toBe(second.binPath);
    expect(await runs()).toHaveLength(2);
    expect(mcpPackageDir("server@1", root, { NPM_CONFIG_A: "a", npm_config_b: "b" })).toBe(
      mcpPackageDir("server@1", root, { npm_config_b: "b", NPM_CONFIG_A: "a" }),
    );
  });

  it("installs once, publishes a ready dir, and returns an executable bin", async () => {
    const onInstall = { calls: 0 };
    const first = await ensureMcpPackage("@demo/server@1.0.0", {
      ...options(),
      onInstall: () => {
        onInstall.calls += 1;
      },
    });
    expect(isInstalledMcpBin(first)).toBe(true);
    expect(first.binPath).toMatch(/node_modules\/@demo\/server\/bin\/server\.js$/);
    expect(execFileSync(first.binPath, { encoding: "utf8" })).toContain("ran @demo/server");

    const second = await ensureMcpPackage("@demo/server@1.0.0", {
      ...options(),
      onInstall: () => {
        onInstall.calls += 1;
      },
    });
    expect(second.binPath).toBe(first.binPath);
    expect(await runs()).toEqual(["@demo/server@1.0.0"]);
    expect(onInstall.calls).toBe(1);
    expect(await leftovers()).toEqual([]);
    // A plain object with the same shape is not an issued bin.
    expect(isInstalledMcpBin({ binPath: first.binPath })).toBe(false);
  });

  it("shares one install between concurrent callers", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureMcpPackage("server@1.0.0", options({ NPM_CONFIG_FAKE_DELAY_MS: "200" })),
      ),
    );
    expect(new Set(results.map((bin) => bin.binPath)).size).toBe(1);
    expect(await runs()).toEqual(["server@1.0.0"]);
  });

  it("never publishes an interrupted install, and the next call recovers", async () => {
    await expect(
      ensureMcpPackage("server@2.0.0", {
        ...options({ NPM_CONFIG_FAKE_MODE: "hang" }),
        timeoutMs: 500,
      }),
    ).rejects.toThrow("npm install server@2.0.0 timed out");
    expect((await readdir(root)).filter((entry) => !entry.startsWith("."))).toEqual([]);
    expect(await leftovers()).toEqual([]);

    const bin = await ensureMcpPackage("server@2.0.0", options());
    expect(execFileSync(bin.binPath, { encoding: "utf8" })).toContain("ran server");
  });

  it("reports npm's output when the install fails and cleans up", async () => {
    await expect(
      ensureMcpPackage("missing@1.0.0", options({ NPM_CONFIG_FAKE_MODE: "fail" })),
    ).rejects.toThrow(/npm install missing@1.0.0 failed \(exit 1\): npm ERR! 404 Not Found/);
    expect(await readdir(root)).toEqual([]);
  });

  it("takes over the lock and debris of a crashed install", async () => {
    const probe = await ensureMcpPackage("server@3.0.0", options());
    const key = basename(mcpPackageDir("server@3.0.0", root, options().env));
    await rm(join(root, key), { recursive: true, force: true });
    // A process on another host died mid-install: its lock expired, its staging dir remains.
    await mkdir(join(root, `${key}.lock`));
    await writeFile(
      join(root, `${key}.lock`, "owner"),
      JSON.stringify({ token: "old", pid: 1, host: "other-host", expiresAt: Date.now() - 1 }),
    );
    await mkdir(join(root, `.tmp-${key}-crashed`, "node_modules"), { recursive: true });

    const bin = await ensureMcpPackage("server@3.0.0", options());
    expect(bin.binPath).toBe(probe.binPath);
    expect(await leftovers()).toEqual([]);
    expect(await runs()).toHaveLength(2);
  });

  it("waits for another process that holds the lock instead of installing twice", async () => {
    const probe = await ensureMcpPackage("server@4.0.0", options());
    const key = basename(mcpPackageDir("server@4.0.0", root, options().env));
    const ready = join(root, key);
    const aside = join(work, "aside");
    await mkdir(aside);
    await rename(ready, join(aside, key));
    // Another live process (same host, this pid) is installing.
    const lock = join(root, `${key}.lock`);
    await mkdir(lock);
    await writeFile(
      join(lock, "owner"),
      JSON.stringify({
        token: "other",
        pid: process.pid,
        host: hostname(),
        expiresAt: Date.now() + 60_000,
      }),
    );

    const waiting = ensureMcpPackage("server@4.0.0", options());
    await new Promise((done) => setTimeout(done, 400));
    // It publishes and releases the lock; the waiter picks the result up.
    await rename(join(aside, key), ready);
    await rm(lock, { recursive: true, force: true });

    expect((await waiting).binPath).toBe(probe.binPath);
    expect(await runs()).toHaveLength(1);
  });

  it("stops waiting on abort while the install finishes for the next caller", async () => {
    const controller = new AbortController();
    const waiting = ensureMcpPackage("server@5.0.0", {
      ...options({ NPM_CONFIG_FAKE_DELAY_MS: "300" }),
      signal: controller.signal,
    });
    controller.abort(new Error("run cancelled"));
    await expect(waiting).rejects.toThrow("run cancelled");
    const bin = await ensureMcpPackage(
      "server@5.0.0",
      options({ NPM_CONFIG_FAKE_DELAY_MS: "300" }),
    );
    expect(execFileSync(bin.binPath, { encoding: "utf8" })).toContain("ran server");
    expect(await runs()).toHaveLength(1);
  });

  it("observes a shared install rejection even when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before install"));
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    await expect(
      ensureMcpPackage("missing@2", {
        ...options({ NPM_CONFIG_FAKE_MODE: "fail" }),
        signal: controller.signal,
        onSettled: async () => {
          settled();
        },
      }),
    ).rejects.toThrow("cancelled before install");
    await done;
    expect(await leftovers()).toEqual([]);
  });

  it("picks npx's bin: named, single, or the package's own", async () => {
    const bins = JSON.stringify({ alpha: "a.js", multi: "m.js" });
    const named = await ensureMcpPackage("multi@1.0.0", {
      ...options({ NPM_CONFIG_FAKE_BIN: bins }),
      binName: "alpha",
    });
    expect(named.binPath).toMatch(/multi\/a\.js$/);
    const own = await ensureMcpPackage("multi@1.0.0", options({ NPM_CONFIG_FAKE_BIN: bins }));
    expect(own.binPath).toMatch(/multi\/m\.js$/);
    await expect(
      ensureMcpPackage("multi@1.0.0", {
        ...options({ NPM_CONFIG_FAKE_BIN: bins }),
        binName: "nope",
      }),
    ).rejects.toThrow("multi has no bin named nope (available: alpha, multi)");
    const single = await ensureMcpPackage(
      "solo@1.0.0",
      options({ NPM_CONFIG_FAKE_BIN: '"cli.js"' }),
    );
    expect(single.binPath).toMatch(/solo\/cli\.js$/);
    const aliased = await ensureMcpPackage(
      "aliased@1.0.0",
      options({ NPM_CONFIG_FAKE_BIN: JSON.stringify({ "srv-a": "s.js", "srv-b": "s.js" }) }),
    );
    expect(aliased.binPath).toMatch(/aliased\/s\.js$/);
  });

  it("refuses specs that are not registry packages", async () => {
    await expect(ensureMcpPackage("../evil", options())).rejects.toThrow("Not an npm registry");
  });

  it("installs a real package with npm, offline, from a local tarball", async () => {
    const fixture = join(work, "fixture");
    await mkdir(join(fixture, "bin"), { recursive: true });
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({ name: "fixture-mcp", version: "1.0.0", bin: { "fixture-mcp": "bin/x.js" } }),
    );
    await writeFile(join(fixture, "bin", "x.js"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
    const tarball = join(
      work,
      execFileSync("npm", ["pack", "--silent", "--pack-destination", work], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_CACHE: join(work, "npm-cache") },
      }).trim(),
    );

    const bin = await ensureMcpPackage("fixture-mcp@1.0.0", {
      root,
      installTarget: tarball,
      env: { NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_CACHE: join(work, "npm-cache") },
    });
    expect(execFileSync(bin.binPath, { encoding: "utf8" }).trim()).toBe("fixture");
    expect(
      existsSync(
        join(
          mcpPackageDir("fixture-mcp@1.0.0", root, {
            NPM_CONFIG_OFFLINE: "true",
            NPM_CONFIG_CACHE: join(work, "npm-cache"),
          }),
          ".ready",
        ),
      ),
    ).toBe(true);
  }, 60_000);
});
