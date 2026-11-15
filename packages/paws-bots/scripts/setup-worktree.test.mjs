import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./setup-worktree.mjs", import.meta.url));

test("worktree settings stay private and local", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rakazo worktree "));
  const main = path.join(dir, "main");
  const worktree = path.join(dir, process.platform === "win32" ? "worktree" : "worktree ");
  const git = (...args) => execFileSync("git", args, { cwd: main, stdio: "pipe" });
  const setup = (cwd) => execFileSync(process.execPath, [script], { cwd, stdio: "pipe" });
  try {
    execFileSync("git", ["init", main], { stdio: "pipe" });
    writeFileSync(path.join(main, ".gitignore"), ".env\n");
    git("add", ".gitignore");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Fixture");
    git("worktree", "add", "--detach", worktree);
    setup(main);
    setup(worktree);
    assert.equal(existsSync(path.join(worktree, ".env")), false);

    const settings = "RAKAZO_DEV_TAILNET=\nBETTER_AUTH_SECRET=fake-test-secret\n";
    writeFileSync(path.join(main, ".env"), settings);
    setup(worktree);
    assert.equal(readFileSync(path.join(worktree, ".env"), "utf8"), settings);
    if (process.platform !== "win32") {
      assert.equal(statSync(path.join(worktree, ".env")).mode & 0o777, 0o600);
    }
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" }),
      "",
    );
    writeFileSync(path.join(worktree, ".env"), "RAKAZO_DEV_TAILNET=0\n");
    setup(worktree);
    assert.equal(readFileSync(path.join(worktree, ".env"), "utf8"), "RAKAZO_DEV_TAILNET=0\n");

    writeFileSync(path.join(worktree, ".gitignore"), "");
    setup(worktree);
    assert.equal(readFileSync(path.join(worktree, ".env"), "utf8"), "RAKAZO_DEV_TAILNET=0\n");
    execFileSync("git", ["add", ".env"], { cwd: worktree, stdio: "pipe" });
    setup(worktree);
    assert.equal(readFileSync(path.join(worktree, ".env"), "utf8"), "RAKAZO_DEV_TAILNET=0\n");
    execFileSync("git", ["reset", "--", ".env"], { cwd: worktree, stdio: "pipe" });
    rmSync(path.join(worktree, ".env"));
    assert.throws(() => setup(worktree));
    assert.equal(existsSync(path.join(worktree, ".env")), false);

    const bare = path.join(dir, "bare.git");
    const bareWorktree = path.join(dir, "bare-worktree");
    git("clone", "--bare", main, bare);
    writeFileSync(path.join(bare, ".env"), settings);
    execFileSync("git", ["--git-dir", bare, "worktree", "add", "--detach", bareWorktree], {
      stdio: "pipe",
    });
    setup(bareWorktree);
    assert.equal(existsSync(path.join(bareWorktree, ".env")), false);

    writeFileSync(path.join(worktree, ".gitignore"), ".env\n");
    git("add", "-f", ".env");
    assert.throws(() => setup(worktree));
    assert.equal(existsSync(path.join(worktree, ".env")), false);
    git("reset", "--", ".env");
    if (process.platform !== "win32") {
      const unrelated = path.join(dir, "unrelated-file");
      writeFileSync(unrelated, "fake-unrelated-secret\n");
      rmSync(path.join(main, ".env"));
      symlinkSync(unrelated, path.join(main, ".env"));
      assert.throws(() => setup(worktree));
      assert.equal(existsSync(path.join(worktree, ".env")), false);
      writeFileSync(path.join(worktree, ".env"), "RAKAZO_DEV_TAILNET=0\n");
      setup(worktree);
      assert.equal(readFileSync(path.join(worktree, ".env"), "utf8"), "RAKAZO_DEV_TAILNET=0\n");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
