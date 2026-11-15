import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const root = git("rev-parse", "--show-toplevel").replace(/\r?\n$/, "");
// Git lists the primary checkout first, regardless of which branch it has checked out.
const primary = git("worktree", "list", "--porcelain", "-z").split("\0\0", 1)[0].split("\0");
// A bare repository has no original checkout whose settings can be inherited.
if (primary.includes("bare")) process.exit(0);
const main = primary[0].slice("worktree ".length);
const source = path.join(main, ".env");
const destination = path.join(root, ".env");

if (root !== main) {
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    console.log("Keeping this worktree's existing .env.");
    process.exit(0);
  }
  const sourceStat = lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) process.exit(0);
  if (!sourceStat.isFile()) throw new Error("The main checkout's .env must be a regular file.");
  // Never copy secrets to a path Git would track, or replace a worktree's own settings.
  execFileSync("git", ["-C", main, "check-ignore", "-q", ".env"]);
  execFileSync("git", ["check-ignore", "-q", destination]);
  const fd = openSync(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("The main checkout's .env must be a regular file.");
    writeFileSync(destination, readFileSync(fd), { flag: "wx", mode: 0o600 });
    console.log("Copied the main checkout's .env to this worktree.");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log("Keeping this worktree's existing .env.");
  } finally {
    closeSync(fd);
  }
}
