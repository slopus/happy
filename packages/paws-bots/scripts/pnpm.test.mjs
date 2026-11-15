import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runPnpm, spawnPnpm } from "./pnpm.mjs";

test("Windows pnpm script entry preserves arguments and process behavior", {
  skip: process.platform !== "win32",
}, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pnpm shim "));
  try {
    const entry = path.join(dir, "pnpm.cjs");
    const marker = path.join(dir, "injected");
    writeFileSync(
      entry,
      `if (process.env.WAIT) { process.stdout.write("ready"); setInterval(() => {}, 1000); } else { process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.MARKER })); process.exit(Number(process.env.EXIT_CODE || 0)); }`,
    );
    const env = { ...process.env, PATH: dir, Path: dir, npm_execpath: entry, MARKER: "test value" };
    const args = [
      "space value",
      `&echo injected>${marker}`,
      'quoted"value',
      "%literal%",
      "!literal!",
      "^literal",
      "|literal",
    ];
    const options = { cwd: dir, env, encoding: "utf8", stdio: "pipe" };
    const expected = { args, cwd: dir, marker: "test value" };
    assert.deepEqual(JSON.parse(runPnpm(args, options)), expected);
    const child = spawnPnpm(args, options);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    assert.deepEqual(await once(child, "close"), [0, null]);
    assert.deepEqual(JSON.parse(output), expected);
    assert.equal(existsSync(marker), false);
    assert.throws(
      () => runPnpm(args, { ...options, env: { ...env, EXIT_CODE: "7" } }),
      (error) => error.status === 7,
    );
    const failed = spawnPnpm(args, { ...options, env: { ...env, EXIT_CODE: "9" } });
    assert.deepEqual(await once(failed, "close"), [9, null]);
    const waiting = spawnPnpm([], { ...options, env: { ...env, WAIT: "1" } });
    await once(waiting.stdout, "data");
    assert.equal(waiting.kill("SIGTERM"), true);
    assert.deepEqual(await once(waiting, "close"), [null, "SIGTERM"]);
    const fallback = { ...options, env: { ...env, npm_execpath: path.join(dir, "npm-cli.js") } };
    assert.throws(
      () => runPnpm(args, fallback),
      (error) => error.code === "ENOENT",
    );
    const missing = spawnPnpm(args, fallback);
    const [error] = await once(missing, "error");
    assert.equal(error.code, "ENOENT");
    const processEnv = process.env;
    const previousEntry = processEnv.npm_execpath;
    processEnv.npm_execpath = entry;
    try {
      const { npm_execpath: _removed, ...withoutEntry } = env;
      assert.throws(
        () => runPnpm(args, { ...options, env: withoutEntry }),
        (error) => error.code === "ENOENT",
      );
    } finally {
      if (previousEntry === undefined) delete processEnv.npm_execpath;
      else processEnv.npm_execpath = previousEntry;
    }

    // Simulate pnpm's Windows shim starting a script with npm_execpath in its environment.
    const helper = fileURLToPath(new URL("./pnpm.mjs", import.meta.url));
    const driver = path.join(dir, "driver.mjs");
    writeFileSync(
      driver,
      `import { runPnpm } from ${JSON.stringify(new URL(`file:///${helper.replaceAll("\\", "/")}`).href)}; process.stdout.write(runPnpm(JSON.parse(process.env.TEST_ARGS), { cwd: process.cwd(), env: process.env, encoding: "utf8", stdio: "pipe" }));`,
    );
    const shim = path.join(dir, "pnpm.cmd");
    writeFileSync(
      shim,
      `@echo off\r\nset "npm_execpath=${entry}"\r\n"${process.execPath}" "${driver}"\r\n`,
    );
    const launched = execFileSync(env.ComSpec, ["/d", "/s", "/c", `""${shim}""`], {
      cwd: dir,
      env: { ...env, TEST_ARGS: JSON.stringify(args) },
      encoding: "utf8",
      windowsVerbatimArguments: true,
    });
    assert.deepEqual(JSON.parse(launched), expected);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
