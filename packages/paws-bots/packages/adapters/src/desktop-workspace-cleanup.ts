import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// A helper process owns its cwd. Every descent verifies the opened directory's inode before
// touching its contents, so replacing an ancestor pathname with a link cannot redirect removal.
const REMOVE_CHILDREN = String.raw`
const fs = require('node:fs');
const expected = JSON.parse(process.argv[1]);
const names = JSON.parse(process.argv[2]);
const same = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
const check = (value) => { if (!same(fs.statSync('.', { bigint: true }), value)) throw new Error('directory changed'); };
function remove(name) {
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('invalid child');
  let child;
  try { child = fs.lstatSync(name, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!child.isDirectory() || child.isSymbolicLink()) { fs.unlinkSync(name); return; }
  const parent = fs.statSync('.', { bigint: true });
  if (child.dev !== parent.dev) throw new Error('workspace mount boundary');
  process.chdir(name);
  check(child);
  if (!(child.mode & 0o200n)) fs.chmodSync('.', Number(child.mode & 0o7777n) | 0o700);
  for (const entry of fs.readdirSync('.')) remove(entry);
  process.chdir('..');
  check(parent);
  const current = fs.lstatSync(name, { bigint: true });
  if (!same(current, child) || current.isSymbolicLink()) throw new Error('directory changed');
  fs.rmdirSync(name);
}
try {
  check(expected);
  for (const name of names) remove(name);
} catch { process.exitCode = 1; }
`;

export async function removeOwnedWorkspaceChildren(
  parent: string,
  names: string[],
  identity: { dev: bigint; ino: bigint },
  signal: AbortSignal,
) {
  await run(
    process.execPath,
    [
      "-e",
      REMOVE_CHILDREN,
      JSON.stringify({ dev: String(identity.dev), ino: String(identity.ino) }),
      JSON.stringify(names),
    ],
    {
      cwd: parent,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      signal,
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
}
