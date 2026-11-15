import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];
const runningWriters = { api: "running", worker: "running", supervisor: "running" };
const stoppedWriters = { api: "stopped", worker: "stopped", supervisor: "stopped" };

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-backup-"));
  temporaryDirectories.push(root);
  const checkout = path.join(root, "checkout with spaces");
  const snapshots = path.join(root, "snapshots");
  const bin = path.join(root, "bin");
  for (const script of [
    "scripts/backup.sh",
    "scripts/restore.sh",
    "infra/compose/backup-prod.sh",
    "infra/compose/backup-drill.sh",
  ]) {
    let source = readFileSync(path.join(repoRoot, script), "utf8");
    if (script.endsWith("backup-prod.sh")) {
      // Relocate only the fixed output directory: never write to real host backups.
      expect(source).toContain('BACKUP_ROOT="/var/backups/rakazo"');
      source = source.replace('BACKUP_ROOT="/var/backups/rakazo"', `BACKUP_ROOT="${snapshots}"`);
    }
    write(path.join(checkout, script), source);
  }
  write(path.join(checkout, ".env"), "EXAMPLE_SETTING=fake-value\n");
  write(path.join(root, "appdata/home.txt"), "example bot home");
  const docker = path.join(bin, "docker");
  write(
    docker,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const client = path.basename(process.argv[1]);
if (client !== "docker") args.unshift(client);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "inspect") {
  console.log(process.env.FAKE_APPDATA);
} else if (args.includes("sh") && args[args.indexOf("sh") + 2]?.startsWith("exec ")) {
  // Run the actual container-side shell, with fake database clients and env.
  const result = spawnSync("/bin/sh", args.slice(args.indexOf("sh") + 1), {
    env: { ...process.env,
      POSTGRES_USER: process.env.FAKE_POSTGRES_USER ?? "rakazo",
      POSTGRES_DB: process.env.FAKE_POSTGRES_DB ?? "rakazo",
    },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
} else if (args[0] !== "compose" && client === "docker") {
  process.exit(90);
} else if (args.includes("pg_dump")) {
  if (process.env.FAIL_DUMP === "1") process.exit(2);
  console.log("CREATE TABLE example (id integer);");
} else if (args.includes("sh") && args.at(-1).startsWith("pg_restore --list ")) {
  fs.readFileSync(0);
  if (process.env.FAIL_VERIFY === "1") process.exit(1);
} else if (args.includes("sh")) {
  if (!args.at(-1).startsWith("pg_dump ")) process.exit(91);
  if (process.env.FAIL_DUMP === "1") process.exit(2);
  if (process.env.OVERSIZE_DUMP === "1") {
    let written = 0;
    while (written < 65536) written += fs.writeSync(1, Buffer.alloc(65536 - written));
  }
  console.log("fake custom-format dump");
} else if (args.includes("psql") && args.includes("-c")) {
  // restore.sh pre-creates the runtime role the dump's grants name.
  if (process.env.FAIL_ROLE === "1") process.exit(24);
} else if (args.includes("psql")) {
  fs.writeFileSync(process.env.SQL_INPUT, fs.readFileSync(0));
  fs.writeFileSync(process.env.SQL_SERVICE_STATE, fs.readFileSync(process.env.SERVICE_STATE));
  if (process.env.FAIL_SQL === "1") {
    console.error("ERROR: relation example already exists");
    // psql normally exits successfully after SQL errors unless explicitly told to stop.
    process.exit(args.includes("--set=ON_ERROR_STOP=on") ? 3 : 0);
  }
} else if (args.includes("ps")) {
  console.log("example-api-container");
} else if (args.includes("stop")) {
  const state = JSON.parse(fs.readFileSync(process.env.SERVICE_STATE, "utf8"));
  const fail = process.env.FAIL_INITIAL_STOP === "1" && !fs.existsSync(process.env.STOP_FAILURE_USED);
  const services = args.slice(args.indexOf("stop") + 1);
  for (const service of fail ? services.slice(0, 1) : services) {
    if (service in state) state[service] = "stopped";
  }
  fs.writeFileSync(process.env.SERVICE_STATE, JSON.stringify(state));
  if (fail) {
    fs.writeFileSync(process.env.STOP_FAILURE_USED, "");
    process.exit(21);
  }
  if (process.env.FAIL_CLEANUP_STOP === "1" && fs.existsSync(process.env.STARTUP_SERVICE_STATE)) process.exit(23);
} else if (args.includes("up")) {
  const services = args.slice(args.indexOf("up") + 1).filter((arg) => !arg.startsWith("-"));
  if (services.includes("postgres")) {
    if (process.env.FAIL_POSTGRES_START === "1") process.exit(22);
  } else {
    const state = JSON.parse(fs.readFileSync(process.env.SERVICE_STATE, "utf8"));
    const requested = services.length ? services : Object.keys(state);
    const starting = process.env.STARTUP_ONLY
      ? requested.filter((service) => service === process.env.STARTUP_ONLY)
      : requested;
    for (const service of starting) {
      if (service in state) state[service] = "running";
    }
    fs.writeFileSync(process.env.SERVICE_STATE, JSON.stringify(state));
    fs.writeFileSync(process.env.STARTUP_SERVICE_STATE, JSON.stringify(state));
    if (process.env.FAIL_STARTUP === "1") {
      console.error("simulated startup failure after starting writers");
      process.exit(19);
    }
    if (process.env.INTERRUPT_STARTUP) process.kill(process.ppid, process.env.INTERRUPT_STARTUP);
  }
} else if (!args.includes("pg_isready")) {
  process.exit(92);
}
`,
  );
  chmodSync(docker, 0o755);
  for (const client of ["pg_dump", "psql", "pg_isready"]) {
    symlinkSync(docker, path.join(bin, client));
  }
  const tar = path.join(bin, "tar");
  write(
    tar,
    `#!/bin/bash
set -eu
if [[ "$1" == "-czf" && "\${OVERSIZE_ARCHIVE:-0}" == "1" ]]; then
  if [[ "$2" == - ]]; then exec dd if=/dev/zero bs=65536 count=1; fi
  exec dd if=/dev/zero of="$2" bs=65536 count=1
fi
if [[ "$1" == "-czf" && "$*" == *" -C "* && -n "\${FAIL_TAR:-}" ]]; then
  echo "simulated archive read failure" >&2
  exit "$FAIL_TAR"
fi
/usr/bin/tar "$@"
if [[ "$1" == "-xzf" && "\${FAIL_EXTRACT:-0}" == "1" ]]; then
  echo "simulated archive extraction failure" >&2
  exit 2
fi
if [[ "$1" == "-czf" && "\${CHANGED_TAR:-0}" == "1" ]]; then
  echo "file changed as we read it" >&2
  exit 1
fi
`,
  );
  chmodSync(tar, 0o755);
  const checksum = path.join(bin, "sha256sum");
  write(
    checksum,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const crypto = require("node:crypto");
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const args = process.argv.slice(2);
if (args[0] === "--check") {
  for (const line of fs.readFileSync(args.at(-1), "utf8").trim().split("\\n")) {
    const [sum, file] = line.split("  ");
    if (hash(file) !== sum) process.exit(1);
  }
} else {
  for (const file of args) console.log(hash(file) + "  " + file);
}
`,
  );
  chmodSync(checksum, 0o755);
  write(
    path.join(bin, "df"),
    `#!/bin/bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/fake 104857600 0 \${FREE_KB:-52428800} 0% /"
`,
  );
  chmodSync(path.join(bin, "df"), 0o755);
  // Offline stand-in for age: a recognizable header, recipients, then the payload in base64, so
  // tests can tell sealed files from plaintext. Decryption needs a listed recipient's identity.
  write(
    path.join(bin, "age"),
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
const lines = (file) => fs.readFileSync(file, "utf8").split("\\n").map((l) => l.trim());
if (args.includes("--decrypt")) {
  const [header, payload = ""] = fs.readFileSync(args.at(-1), "utf8").split("\\n---\\n");
  const keys = value("-i").flatMap(lines).flatMap((l) => l.match(/^# public key: (\\S+)$/)?.slice(1) ?? []);
  if (!keys.some((key) => header.split("\\n").includes("-> fake " + key))) process.exit(1);
  process.stdout.write(Buffer.from(payload, "base64"));
} else {
  const recipients = [...value("-r"), ...value("-R").flatMap(lines).filter((l) => l && !l.startsWith("#"))];
  if (!recipients.length || recipients.some((r) => !r.startsWith("age1"))) process.exit(1);
  const sealed = ["age-encryption.org/v1", ...recipients.map((r) => "-> fake " + r), "---", fs.readFileSync(0).toString("base64")].join("\\n");
  value("-o").length ? fs.writeFileSync(value("-o")[0], sealed) : process.stdout.write(sealed);
}
`,
  );
  chmodSync(path.join(bin, "age"), 0o755);
  // rclone stand-in: "name:path" maps to a local directory; FAIL_RCLONE fails one subcommand.
  write(
    path.join(bin, "rclone"),
    `#!/bin/bash
set -eu
echo "$*" >> "$RCLONE_LOG"
[[ "\${FAIL_RCLONE:-}" != "$1" ]] || exit 1
local_path() { echo "$FAKE_REMOTE/\${1#*:}"; }
command="$1"; shift
paths=(); exclude=""
while (($#)); do
  case "$1" in
    --exclude) exclude="\${2#/}"; shift 2 ;;
    --max-depth) shift 2 ;;
    --one-way|-R|--) shift ;;
    *) paths+=("$1"); shift ;;
  esac
done
case "$command" in
  copy)
    target="$(local_path "\${paths[1]}")"; mkdir -p "$target"
    for file in "\${paths[0]}"/*; do [[ "\${file##*/}" == "$exclude" ]] || cp "$file" "$target/"; done ;;
  copyto) target="$(local_path "\${paths[1]}")"; mkdir -p "\${target%/*}"; cp "\${paths[0]}" "$target" ;;
  check) for file in "\${paths[0]}"/*; do [[ "\${file##*/}" == "$exclude" ]] || cmp -s "$file" "$(local_path "\${paths[1]}")/\${file##*/}"; done ;;
  lsf)
    cd "$(local_path "\${paths[0]}")"
    find . -mindepth 1 -maxdepth 2 | sed 's|^\\./||' | while read -r entry; do
      if [[ -d "$entry" ]]; then echo "$entry/"; else echo "$entry"; fi
    done ;;
  purge) rm -rf -- "$(local_path "\${paths[0]}")" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(path.join(bin, "rclone"), 0o755);
  // The restore drill's pg_restore: accepts only the fake dump's plaintext.
  write(path.join(bin, "pg_restore"), `#!/bin/bash\ngrep -q "custom-format dump"\n`);
  chmodSync(path.join(bin, "pg_restore"), 0o755);
  // No inherited deployment settings, credentials, or executable search paths.
  const env = {
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    COMMAND_LOG: path.join(root, "commands.jsonl"),
    SQL_INPUT: path.join(root, "input.sql"),
    SQL_SERVICE_STATE: path.join(root, "sql-service-state"),
    SERVICE_STATE: path.join(root, "service-state"),
    STARTUP_SERVICE_STATE: path.join(root, "startup-service-state"),
    STOP_FAILURE_USED: path.join(root, "stop-failure-used"),
    FAKE_APPDATA: path.join(root, "appdata"),
    FAKE_REMOTE: path.join(root, "remote"),
    RCLONE_LOG: path.join(root, "rclone.log"),
  };
  write(env.SERVICE_STATE, JSON.stringify(runningWriters));
  return {
    root,
    checkout,
    snapshots,
    env,
    run(script: string, args: string[] = [], overrides: Record<string, string> = {}) {
      const result = spawnSync("/bin/bash", [path.join(checkout, script), ...args], {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      return result;
    },
    serviceStates(file = env.SERVICE_STATE) {
      return JSON.parse(readFileSync(file, "utf8"));
    },
    commands(): string[][] {
      if (!existsSync(env.COMMAND_LOG)) return [];
      return readFileSync(env.COMMAND_LOG, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

/** Snapshot directories, without the backup lock file. */
function snapshotNames(root: string) {
  return readdirSync(root).filter((name) => name !== ".lock");
}

function contents(archive: string) {
  return execFileSync("/usr/bin/tar", ["-tzf", archive], { encoding: "utf8" });
}

describe("development database configuration", () => {
  it.each([
    ["rakazo", "rakazo"],
    ["custom_admin", "custom_db"],
    ["admin with spaces", "db with $dollar; punctuation"],
  ])("uses container credentials %j / %j for backup and restore", (user, database) => {
    const f = fixture();
    const overrides = {
      FAKE_POSTGRES_USER: user,
      FAKE_POSTGRES_DB: database,
      POSTGRES_USER: "different_host_user",
      POSTGRES_DB: "different_host_database",
    };
    const backup = f.run("scripts/backup.sh", ["example"], overrides);
    expect(backup.status, backup.stderr).toBe(0);
    const restore = f.run(
      "scripts/restore.sh",
      [path.join(f.checkout, "backups/example")],
      overrides,
    );
    expect(restore.status, restore.stderr).toBe(0);
    const clients = f
      .commands()
      .filter((args) => ["pg_dump", "pg_isready", "psql"].some((client) => args.includes(client)));
    expect(clients).toHaveLength(4);
    for (const args of clients) {
      expect(args[args.indexOf("-U") + 1]).toBe(user);
      expect(args[args.indexOf("-d") + 1]).toBe(database);
    }
    expect(readFileSync(f.env.SQL_INPUT, "utf8")).toContain("CREATE TABLE example");
  });
});

describe("development backup failures", () => {
  it.each([false, true])("archives data with a root env file present: %s", (hasEnv) => {
    const f = fixture();
    if (!hasEnv) rmSync(path.join(f.checkout, ".env"));
    write(path.join(f.checkout, "data/home.txt"), "example home");
    // A single path component may still contain spaces.
    const stamp = hasEnv ? " snapshot with spaces " : "example";
    const result = f.run("scripts/backup.sh", [stamp]);
    expect(result.status, result.stderr).toBe(0);
    const output = path.join(f.checkout, "backups", stamp);
    expect(readFileSync(path.join(output, "rakazo.sql"), "utf8")).toContain("CREATE TABLE");
    expect(contents(path.join(output, "homes.tgz"))).toContain("data/home.txt");
    expect(f.commands()[0]!.includes("--env-file")).toBe(hasEnv);
    if (hasEnv) expect(f.commands()[0]).toContain(path.join(f.checkout, ".env"));
  });

  it.each(["", ".", "..", "../data", "link/snapshot"])(
    "rejects unsafe stamp %j without changing contents or modes",
    (stamp) => {
      const f = fixture();
      const backups = path.join(f.checkout, "backups");
      const outside = path.join(f.root, "outside");
      const directories = [
        f.checkout,
        backups,
        path.join(f.checkout, "data"),
        outside,
        path.join(outside, "snapshot"),
      ];
      for (const directory of directories) {
        write(path.join(directory, "rakazo.sql"), "existing database backup");
        write(path.join(directory, "homes.tgz"), "existing homes backup");
        chmodSync(directory, 0o755);
        chmodSync(path.join(directory, "rakazo.sql"), 0o644);
        chmodSync(path.join(directory, "homes.tgz"), 0o640);
      }
      symlinkSync(outside, path.join(backups, "link"));
      const entries = directories.map((directory) => readdirSync(directory).sort());

      const result = f.run("scripts/backup.sh", [stamp]);

      expect(result.status).not.toBe(0);
      expect(f.commands()).toEqual([]);
      for (const [index, directory] of directories.entries()) {
        expect(readdirSync(directory).sort()).toEqual(entries[index]);
        expect(statSync(directory).mode & 0o777).toBe(0o755);
        expect(readFileSync(path.join(directory, "rakazo.sql"), "utf8")).toBe(
          "existing database backup",
        );
        expect(readFileSync(path.join(directory, "homes.tgz"), "utf8")).toBe(
          "existing homes backup",
        );
        expect(statSync(path.join(directory, "rakazo.sql")).mode & 0o777).toBe(0o644);
        expect(statSync(path.join(directory, "homes.tgz")).mode & 0o777).toBe(0o640);
      }
    },
  );

  it.each([false, true])("keeps new and reused backups private: %s", (reuse) => {
    const f = fixture();
    write(path.join(f.checkout, "data/home.txt"), "example home");
    const output = path.join(f.checkout, "backups/private");
    if (reuse) {
      write(path.join(output, "rakazo.sql"), "old dump");
      write(path.join(output, "homes.tgz"), "old archive");
      chmodSync(path.dirname(output), 0o777);
      chmodSync(output, 0o777);
      chmodSync(path.join(output, "rakazo.sql"), 0o666);
      chmodSync(path.join(output, "homes.tgz"), 0o666);
    }
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        'umask 022; exec bash "$1" private',
        "backup-permissions",
        path.join(f.checkout, "scripts/backup.sh"),
      ],
      { cwd: f.root, env: f.env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(path.dirname(output)).mode & 0o777).toBe(0o700);
    expect(statSync(output).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(output, "rakazo.sql")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(output, "homes.tgz")).mode & 0o777).toBe(0o600);
  });

  it("keeps reused artifacts private and unreplaced when the database dump fails", () => {
    const f = fixture();
    const output = path.join(f.checkout, "backups/example");
    for (const name of ["rakazo.sql", "homes.tgz"]) {
      write(path.join(output, name), "old backup");
      chmodSync(path.join(output, name), 0o666);
    }
    chmodSync(output, 0o755);

    const result = f.run("scripts/backup.sh", ["example"], { FAIL_DUMP: "1" });

    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("Backup written");
    expect(readFileSync(path.join(output, "homes.tgz"), "utf8")).toBe("old backup");
    expect(statSync(output).mode & 0o777).toBe(0o700);
    for (const name of ["rakazo.sql", "homes.tgz"]) {
      expect(statSync(path.join(output, name)).mode & 0o777).toBe(0o600);
    }
  });

  it.each(["directory", "artifact"])("does not write through a backup %s symlink", (kind) => {
    const f = fixture();
    const target = path.join(f.root, "outside");
    const output = path.join(f.checkout, "backups/example");
    if (kind === "directory") {
      write(path.join(target, "rakazo.sql"), "keep this");
      mkdirSync(path.dirname(output), { recursive: true });
      symlinkSync(target, output);
    } else {
      write(target, "keep this");
      mkdirSync(output, { recursive: true });
      symlinkSync(target, path.join(output, "rakazo.sql"));
    }

    const result = f.run("scripts/backup.sh", ["example"]);

    expect(result.status).not.toBe(0);
    expect(
      readFileSync(kind === "directory" ? path.join(target, "rakazo.sql") : target, "utf8"),
    ).toBe("keep this");
    expect(f.commands()).toEqual([]);
  });

  it.each(["absent", "skipped"])("allows an empty archive when data is %s", (scenario) => {
    const f = fixture();
    if (scenario === "skipped") write(path.join(f.checkout, "data/home.txt"), "example home");
    const result = f.run("scripts/backup.sh", ["example"], {
      RAKAZO_BACKUP_SKIP_HOMES: scenario === "skipped" ? "1" : "0",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(contents(path.join(f.checkout, "backups/example/homes.tgz"))).toBe("");
  });

  it.each(["file", "broken link", "directory link"])("rejects a data path that is a %s", (kind) => {
    const f = fixture();
    const data = path.join(f.checkout, "data");
    if (kind === "file") write(data, "not a directory");
    else {
      const target = path.join(f.root, kind === "directory link" ? "appdata" : "missing");
      symlinkSync(target, data);
    }
    const result = f.run("scripts/backup.sh", ["example"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Backup written");
  });

  it("propagates the tar exit production tolerates without replacing the failed archive", () => {
    const f = fixture();
    write(path.join(f.checkout, "data/home.txt"), "example home");
    const result = f.run("scripts/backup.sh", ["example"], { FAIL_TAR: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated archive read failure");
    expect(result.stdout).not.toContain("Backup written");
    expect(existsSync(path.join(f.checkout, "backups/example/homes.tgz"))).toBe(false);
  });
});

describe("development restore failures", () => {
  let homesArchive: Buffer;

  beforeAll(() => {
    const source = mkdtempSync(path.join(os.tmpdir(), "rakazo-restore-source-"));
    try {
      write(path.join(source, "data/home.txt"), "backed-up home");
      homesArchive = execFileSync("/usr/bin/tar", ["-czf", "-", "-C", source, "data"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  function restoreFixture() {
    const f = fixture();
    const snapshot = path.join(f.checkout, "backups/example");
    write(path.join(snapshot, "rakazo.sql"), "CREATE TABLE example (id integer);\n");
    writeFileSync(path.join(snapshot, "homes.tgz"), homesArchive);
    write(path.join(f.checkout, "data/home.txt"), "current home");
    return f;
  }

  it.each([false, true])(
    "restores files and starts services only after SQL succeeds: %s",
    (fail) => {
      const f = restoreFixture();
      write(path.join(f.checkout, "data/post-snapshot.txt"), "current-only file");
      const result = f.run("scripts/restore.sh", [path.join(f.checkout, "backups/example")], {
        FAIL_SQL: fail ? "1" : "0",
      });
      expect(result.status).toBe(fail ? 3 : 0);
      const psql = f.commands().filter((args) => args.includes("psql"));
      expect(psql[0]?.at(-1)).toContain("CREATE ROLE rakazo_app NOLOGIN");
      const command = psql.find((args) => args.includes("--single-transaction"));
      expect(command).toEqual(
        expect.arrayContaining([
          "-X",
          "--set=ON_ERROR_STOP=on",
          "--single-transaction",
          "--file=-",
        ]),
      );
      expect(readFileSync(f.env.SQL_INPUT, "utf8")).toContain("CREATE TABLE example");
      expect(f.serviceStates(f.env.SQL_SERVICE_STATE)).toEqual(stoppedWriters);
      expect(f.serviceStates()).toEqual(fail ? stoppedWriters : runningWriters);
      expect(readFileSync(path.join(f.checkout, "data/home.txt"), "utf8")).toBe(
        fail ? "current home" : "backed-up home",
      );
      expect(existsSync(path.join(f.checkout, "data/post-snapshot.txt"))).toBe(fail);
      expect(f.commands().some((args) => args.slice(-2).join(" ") === "up -d")).toBe(!fail);
      expect(result.stdout.includes("Restore complete")).toBe(!fail);
      expect(readdirSync(f.checkout).some((name) => name.startsWith(".restore."))).toBe(false);
      const rollbacks = readdirSync(f.checkout).filter((name) => name.startsWith("data.rollback."));
      if (fail) {
        expect(result.stderr).toContain("already exists");
        expect(rollbacks).toEqual([]);
      } else {
        expect(rollbacks).toHaveLength(1);
        const rollback = path.join(f.checkout, rollbacks[0]!);
        expect(statSync(rollback).mode & 0o777).toBe(0o700);
        expect(readFileSync(path.join(rollback, "data/home.txt"), "utf8")).toBe("current home");
        expect(readFileSync(path.join(rollback, "data/post-snapshot.txt"), "utf8")).toBe(
          "current-only file",
        );
        expect(result.stdout).toContain(path.join(rollback, "data"));
      }
    },
  );

  it.each([
    { stage: "initial writer stop", setting: "FAIL_INITIAL_STOP", status: 21 },
    { stage: "Postgres startup", setting: "FAIL_POSTGRES_START", status: 22 },
    { stage: "role setup", setting: "FAIL_ROLE", status: 24 },
  ])("stops every writer after $stage fails", ({ setting, status }) => {
    const f = restoreFixture();

    const result = f.run("scripts/restore.sh", [path.join(f.checkout, "backups/example")], {
      [setting]: "1",
    });

    expect(result.status).toBe(status);
    expect(f.serviceStates()).toEqual(stoppedWriters);
    expect(existsSync(f.env.SQL_INPUT)).toBe(false);
    expect(readFileSync(path.join(f.checkout, "data/home.txt"), "utf8")).toBe("current home");
    expect(result.stdout).not.toContain("Restore complete");
    expect(readdirSync(f.checkout).some((name) => name.startsWith(".restore."))).toBe(false);
  });

  it.each([
    { failure: "partial exit", status: 19 },
    { failure: "SIGHUP", status: 129 },
    { failure: "SIGINT", status: 130 },
    { failure: "SIGTERM", status: 143 },
  ])(
    "stops every writer after startup $failure and preserves both recovery trees",
    ({ failure, status }) => {
      const f = restoreFixture();
      write(path.join(f.checkout, "data/current-only.txt"), "preserve this file");

      const result = f.run("scripts/restore.sh", [path.join(f.checkout, "backups/example")], {
        FAIL_STARTUP: failure === "partial exit" ? "1" : "0",
        INTERRUPT_STARTUP: failure.startsWith("SIG") ? failure : "",
        STARTUP_ONLY: failure === "partial exit" ? "api" : "",
        FAIL_CLEANUP_STOP: "1",
      });

      expect(result.status).toBe(status);
      expect(f.serviceStates(f.env.SQL_SERVICE_STATE)).toEqual(stoppedWriters);
      expect(f.serviceStates(f.env.STARTUP_SERVICE_STATE)).toEqual(
        failure === "partial exit" ? { ...stoppedWriters, api: "running" } : runningWriters,
      );
      expect(f.serviceStates()).toEqual(stoppedWriters);
      expect(readFileSync(path.join(f.checkout, "data/home.txt"), "utf8")).toBe("backed-up home");
      expect(existsSync(path.join(f.checkout, "data/current-only.txt"))).toBe(false);
      const rollbacks = readdirSync(f.checkout).filter((name) => name.startsWith("data.rollback."));
      expect(rollbacks).toHaveLength(1);
      const rollback = path.join(f.checkout, rollbacks[0]!, "data");
      expect(readFileSync(path.join(rollback, "home.txt"), "utf8")).toBe("current home");
      expect(readFileSync(path.join(rollback, "current-only.txt"), "utf8")).toBe(
        "preserve this file",
      );
      expect(result.stdout).not.toContain("Restore complete");
      expect(readdirSync(f.checkout).some((name) => name.startsWith(".restore."))).toBe(false);
    },
  );

  it.each(["corrupt", "extraction failure"])("rejects a %s homes archive before SQL", (kind) => {
    const f = restoreFixture();
    if (kind === "corrupt") {
      write(path.join(f.checkout, "backups/example/homes.tgz"), "invalid archive");
    }
    const result = f.run("scripts/restore.sh", [path.join(f.checkout, "backups/example")], {
      FAIL_EXTRACT: kind === "extraction failure" ? "1" : "0",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Restore complete");
    expect(f.commands().some((args) => args.slice(-2).join(" ") === "up -d")).toBe(false);
    expect(existsSync(f.env.SQL_INPUT)).toBe(false);
    expect(f.commands().some((args) => args.includes("psql"))).toBe(false);
    expect(readFileSync(path.join(f.checkout, "data/home.txt"), "utf8")).toBe("current home");
    expect(readdirSync(f.checkout).some((name) => name.startsWith(".restore."))).toBe(false);
  });

  it("keeps the previous tree outside active data if the post-SQL tree switch fails", () => {
    const f = restoreFixture();
    write(path.join(f.checkout, "data/current-only.txt"), "preserve this file");
    const mv = path.join(f.root, "bin/mv");
    write(
      mv,
      `#!/bin/bash
if [[ ! -e "$ACTIVE_DATA" ]]; then
  for argument in "$@"; do
    if [[ "$argument" == "$ACTIVE_DATA" ]]; then exit 17; fi
  done
fi
PATH=/usr/bin:/bin exec mv "$@"
`,
    );
    chmodSync(mv, 0o755);

    const result = f.run("scripts/restore.sh", [path.join(f.checkout, "backups/example")], {
      ACTIVE_DATA: path.join(f.checkout, "data"),
    });

    expect(result.status).toBe(17);
    expect(readFileSync(f.env.SQL_INPUT, "utf8")).toContain("CREATE TABLE example");
    expect(f.serviceStates()).toEqual(stoppedWriters);
    expect(existsSync(path.join(f.checkout, "data"))).toBe(false);
    const rollback = readdirSync(f.checkout).find((name) => name.startsWith("data.rollback."));
    expect(rollback).toBeDefined();
    expect(readFileSync(path.join(f.checkout, rollback!, "data/home.txt"), "utf8")).toBe(
      "current home",
    );
    expect(readFileSync(path.join(f.checkout, rollback!, "data/current-only.txt"), "utf8")).toBe(
      "preserve this file",
    );
    expect(result.stdout).not.toContain("Restore complete");
  });

  it.each(["missing", "skipped", "empty data"])("handles a %s homes snapshot", (kind) => {
    const f = restoreFixture();
    const snapshot = path.join(f.checkout, "backups/example");
    if (kind === "missing") {
      rmSync(path.join(snapshot, "homes.tgz"));
    } else if (kind === "skipped") {
      expect(
        f.run("scripts/backup.sh", ["example"], { RAKAZO_BACKUP_SKIP_HOMES: "1" }).status,
      ).toBe(0);
    } else {
      const source = path.join(f.root, "empty-snapshot");
      mkdirSync(path.join(source, "data"), { recursive: true });
      execFileSync("/usr/bin/tar", [
        "-czf",
        path.join(snapshot, "homes.tgz"),
        "-C",
        source,
        "data",
      ]);
    }
    write(path.join(f.checkout, "data/post-snapshot.txt"), "keep unless the tree is replaced");

    const result = f.run("scripts/restore.sh", [snapshot]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.env.SQL_INPUT, "utf8")).toContain("CREATE TABLE example");
    if (kind === "empty data") {
      expect(readdirSync(path.join(f.checkout, "data"))).toEqual([]);
      const rollback = readdirSync(f.checkout).find((name) => name.startsWith("data.rollback."));
      expect(rollback).toBeDefined();
      expect(readFileSync(path.join(f.checkout, rollback!, "data/home.txt"), "utf8")).toBe(
        "current home",
      );
    } else {
      expect(readFileSync(path.join(f.checkout, "data/home.txt"), "utf8")).toBe("current home");
      expect(readFileSync(path.join(f.checkout, "data/post-snapshot.txt"), "utf8")).toBe(
        "keep unless the tree is replaced",
      );
      expect(readdirSync(f.checkout).some((name) => name.startsWith("data.rollback."))).toBe(false);
    }
  });

  it.each(["outside data", "data symlink"])("rejects %s archive paths before SQL", (kind) => {
    const f = restoreFixture();
    const source = path.join(f.root, "invalid-snapshot");
    const outside = path.join(f.root, "outside");
    write(path.join(outside, "keep.txt"), "untouched");
    mkdirSync(source);
    const member = kind === "outside data" ? "unexpected.txt" : "data";
    if (kind === "outside data") write(path.join(source, member), "not app data");
    else symlinkSync(outside, path.join(source, member));
    const snapshot = path.join(f.checkout, "backups/example");
    execFileSync("/usr/bin/tar", ["-czf", path.join(snapshot, "homes.tgz"), "-C", source, member]);

    const result = f.run("scripts/restore.sh", [snapshot]);

    expect(result.status).not.toBe(0);
    expect(existsSync(f.env.SQL_INPUT)).toBe(false);
    expect(f.commands().some((args) => args.includes("psql"))).toBe(false);
    expect(readFileSync(path.join(f.checkout, "data/home.txt"), "utf8")).toBe("current home");
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("untouched");
    expect(f.serviceStates()).toEqual(runningWriters);
  });

  it.each(["file", "directory link"])("rejects active data %s", (kind) => {
    const f = restoreFixture();
    const data = path.join(f.checkout, "data");
    rmSync(data, { recursive: true });
    if (kind === "file") write(data, "keep this file");
    else symlinkSync(path.join(f.root, "appdata"), data);

    const result = f.run("scripts/restore.sh", [path.join(f.checkout, "backups/example")]);

    expect(result.status).not.toBe(0);
    expect(existsSync(f.env.SQL_INPUT)).toBe(false);
    expect(f.commands().some((args) => args.includes("psql"))).toBe(false);
    if (kind === "file") expect(readFileSync(data, "utf8")).toBe("keep this file");
    else
      expect(readFileSync(path.join(f.root, "appdata/home.txt"), "utf8")).toBe("example bot home");
  });
});

describe("production backup deployment and archive behavior", () => {
  it.each([false, true])("uses the configured deployment directory: %s", (custom) => {
    const f = fixture();
    const deployment = custom ? f.checkout : "/srv/rakazo";
    const result = f.run(
      "infra/compose/backup-prod.sh",
      [],
      custom ? { RAKAZO_DEPLOY_DIR: deployment } : {},
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Verified Rakazo backup");
    expect(result.stderr).toContain("not encrypted");
    expect(readdirSync(result.stdout.trim().split("written to ")[1]!).sort()).toEqual([
      "SHA256SUMS",
      "SOURCE_SIZE_KB",
      "appdata.tgz",
      "rakazo.dump",
    ]);
    for (const command of f.commands().filter((args) => args[0] === "compose")) {
      expect(command.slice(0, 5)).toEqual([
        "compose",
        "--env-file",
        path.join(deployment, ".env"),
        "-f",
        path.join(deployment, "infra/compose/docker-compose.prod.yml"),
      ]);
    }
  });

  it("rejects relative deployment paths before any backup commands", () => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], { RAKAZO_DEPLOY_DIR: "relative" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("absolute path");
    expect(f.commands()).toEqual([]);
    expect(existsSync(f.snapshots)).toBe(false);
  });

  it("preserves host archiving and the live-file warning allowance from PR #618", () => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], { CHANGED_TAR: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("file changed as we read it");
    expect(result.stdout).toContain("Verified Rakazo backup");
    const snapshot = result.stdout.trim().split("written to ")[1]!;
    expect(contents(path.join(snapshot, "appdata.tgz"))).toContain("home.txt");
    expect(existsSync(path.join(snapshot, "SHA256SUMS"))).toBe(true);
    expect(f.commands().some((args) => args[0] === "inspect")).toBe(true);
    expect(f.commands().some((args) => args.includes("tar"))).toBe(false);
  });

  it.each<Record<string, string>>([{ FAIL_TAR: "2" }, { FAIL_DUMP: "1" }, { FAIL_VERIFY: "1" }])(
    "does not report a verified snapshot after failure: %j",
    (failure) => {
      const f = fixture();
      const result = f.run("infra/compose/backup-prod.sh", [], failure);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("Verified Rakazo backup");
      expect(snapshotNames(f.snapshots)).toEqual([]);
    },
  );

  it("keeps the newest verified snapshots and drops older and partial ones", () => {
    const f = fixture();
    const stamps = ["20261014T000000Z", "20261015T000000Z", "20261016T000000Z", "20261017T000000Z"];
    for (const stamp of stamps) write(path.join(f.snapshots, stamp, "SHA256SUMS"), "sums");
    write(path.join(f.snapshots, "20261018T000000Z/appdata.tgz"), "partial");
    write(path.join(f.snapshots, "notes/keep.txt"), "not a snapshot");
    const result = f.run("infra/compose/backup-prod.sh", [], { RAKAZO_BACKUP_KEEP: "2" });
    expect(result.status, result.stderr).toBe(0);
    const current = path.basename(result.stdout.trim().split("written to ")[1]!);
    expect(snapshotNames(f.snapshots).sort()).toEqual(
      ["20261017T000000Z", current, "notes"].sort(),
    );
  });

  it("fails before writing when the disk is short, still cleaning abandoned partials", () => {
    const f = fixture();
    write(path.join(f.snapshots, "20261017T000000Z/SHA256SUMS"), "x".repeat(64 * 1024));
    write(path.join(f.snapshots, "20261018T000000Z/appdata.tgz"), "partial");
    write(path.join(f.snapshots, "notes/keep.txt"), "operator note");
    const result = f.run("infra/compose/backup-prod.sh", [], { FREE_KB: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("this backup needs about");
    expect(snapshotNames(f.snapshots).sort()).toEqual(["20261017T000000Z", "notes"]);
    expect(f.commands().some((args) => args.includes("sh"))).toBe(false);
  });

  it("preserves the newest verified backup when the storage budget is too small", () => {
    const f = fixture();
    write(path.join(f.snapshots, "20261016T000000Z/SHA256SUMS"), "older");
    write(path.join(f.snapshots, "20261017T000000Z/SHA256SUMS"), "newest");
    const result = f.run("infra/compose/backup-prod.sh", [], { RAKAZO_BACKUP_MAX_GB: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Keeping the latest verified snapshot");
    expect(snapshotNames(f.snapshots)).toEqual(["20261017T000000Z"]);
    expect(f.commands().some((args) => args.includes("pg_dump"))).toBe(false);
  });

  it("refuses to fall back to root storage when a separate volume is required", () => {
    const f = fixture();
    const mountpoint = path.join(f.root, "bin/mountpoint");
    write(mountpoint, "#!/bin/bash\nexit 1\n");
    chmodSync(mountpoint, 0o755);
    const result = f.run("infra/compose/backup-prod.sh", [], { RAKAZO_BACKUP_REQUIRE_VOLUME: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("backup volume");
    expect(f.commands()).toEqual([]);
    expect(existsSync(f.snapshots)).toBe(false);
  });

  it.each([false, true])("estimates compressed storage using source growth: %s", (grown) => {
    const f = fixture();
    const last = path.join(f.snapshots, "20261017T000000Z");
    write(path.join(last, "SHA256SUMS"), "verified");
    write(path.join(last, "SOURCE_SIZE_KB"), "10485760\n");
    write(path.join(last, "appdata.tgz"), "archive");
    write(path.join(last, "rakazo.dump"), "dump");
    const du = path.join(f.root, "bin/du");
    write(
      du,
      `#!/bin/bash
if [[ "$2" == "$FAKE_APPDATA" ]]; then
  echo "$FAKE_RAW_KB $2"
elif [[ "$2" == "${last}" || "$2" == "${last}/appdata.tgz" ]]; then
  echo "1048576 $2"
else
  exec /usr/bin/du "$@"
fi
`,
    );
    chmodSync(du, 0o755);
    const result = f.run("infra/compose/backup-prod.sh", [], {
      FAKE_RAW_KB: grown ? "20971520" : "10485760",
      RAKAZO_BACKUP_MAX_GB: "3",
      RAKAZO_BACKUP_MIN_FREE_GB: "1",
    });
    expect(result.status, result.stderr).toBe(grown ? 1 : 0);
    expect(existsSync(path.join(last, "SHA256SUMS"))).toBe(true);
  });

  it.each(["dump", "archive"])(
    "enforces actual %s output limits and preserves the latest backup",
    (output) => {
      const f = fixture();
      const last = path.join(f.snapshots, "20261017T000000Z");
      write(path.join(last, "SHA256SUMS"), "verified");
      const df = path.join(f.root, "bin/df");
      write(
        df,
        `#!/bin/bash
free=52428800
for snapshot in "${f.snapshots}"/*; do
  if [[ -f "$snapshot/SOURCE_SIZE_KB" && ! -f "$snapshot/SHA256SUMS" ]]; then
    if [[ "${output}" == dump || -f "$snapshot/rakazo.dump" ]]; then free=1048584; fi
  fi
done
echo "Filesystem Blocks Used Available Capacity Mounted"
echo "/dev/fake 104857600 0 $free 0% /"
`,
      );
      chmodSync(df, 0o755);
      const result = f.run("infra/compose/backup-prod.sh", [], {
        RAKAZO_BACKUP_MIN_FREE_GB: "1",
        ...(output === "dump" ? { OVERSIZE_DUMP: "1" } : { OVERSIZE_ARCHIVE: "1" }),
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("Verified Rakazo backup");
      expect(snapshotNames(f.snapshots)).toEqual(["20261017T000000Z"]);
      expect(readFileSync(path.join(last, "SHA256SUMS"), "utf8")).toBe("verified");
    },
  );

  it("does not multiply a large database dump by appdata growth", () => {
    const f = fixture();
    const last = path.join(f.snapshots, "20261017T000000Z");
    for (const file of ["SHA256SUMS", "rakazo.dump", "appdata.tgz"])
      write(path.join(last, file), "verified");
    write(path.join(last, "SOURCE_SIZE_KB"), "102400");
    const du = path.join(f.root, "bin/du");
    write(
      du,
      `#!/bin/bash
case "$2" in
  "$FAKE_APPDATA") size=1048576 ;;
  "${last}/rakazo.dump") size=10485760 ;;
  "${last}/appdata.tgz") size=102400 ;;
  "${last}") size=10588160 ;;
  *) exec /usr/bin/du "$@" ;;
esac
echo "$size $2"
`,
    );
    chmodSync(du, 0o755);
    const result = f.run("infra/compose/backup-prod.sh");
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["files", "directory"])(
    "does not publish a verified backup after %s sync fails",
    (stage) => {
      const f = fixture();
      write(path.join(f.snapshots, "20261017T000000Z/SHA256SUMS"), "verified");
      const sync = path.join(f.root, "bin/sync");
      write(
        sync,
        `#!/bin/bash
if [[ "${stage}" == files && -f "$2" || "${stage}" == directory && -d "$2" ]]; then exit 1; fi
exec /usr/bin/sync "$@"
`,
      );
      chmodSync(sync, 0o755);
      const result = f.run("infra/compose/backup-prod.sh");
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("Verified Rakazo backup");
      expect(snapshotNames(f.snapshots)).toEqual(["20261017T000000Z"]);
    },
  );

  it("never overwrites a completed snapshot when a rerun has the same timestamp", () => {
    const f = fixture();
    const first = f.run("infra/compose/backup-prod.sh");
    expect(first.status, first.stderr).toBe(0);
    const snapshot = first.stdout.trim().split("written to ")[1]!;
    const manifest = readFileSync(path.join(snapshot, "SHA256SUMS"), "utf8");
    const date = path.join(f.root, "bin/date");
    write(date, `#!/bin/bash\necho '${path.basename(snapshot)}'\n`);
    chmodSync(date, 0o755);
    const commandsBefore = f.commands().length;
    const second = f.run("infra/compose/backup-prod.sh", [], { FAIL_DUMP: "1" });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain("File exists");
    expect(
      f
        .commands()
        .slice(commandsBefore)
        .some((args) => args.includes("sh")),
    ).toBe(false);
    expect(readFileSync(path.join(snapshot, "SHA256SUMS"), "utf8")).toBe(manifest);
  });

  it("refuses to run while another backup holds the lock", () => {
    const f = fixture();
    mkdirSync(f.snapshots, { recursive: true });
    const lock = path.join(f.snapshots, ".lock");
    writeFileSync(lock, "");
    const result = spawnSync(
      "flock",
      [lock, "/bin/bash", path.join(f.checkout, "infra/compose/backup-prod.sh")],
      {
        cwd: f.root,
        env: f.env,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Another Rakazo backup is running");
  });

  it("rejects a non-positive retention", () => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], { RAKAZO_BACKUP_KEEP: "0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RAKAZO_BACKUP_KEEP");
  });
});

const recipients = "age1fakeprimary age1fakerecovery";
const identity = "# public key: age1fakerecovery\nAGE-SECRET-KEY-FAKE\n";

function snapshotOf(result: { stdout: string }) {
  return result.stdout.split("written to ")[1]!.split("\n")[0]!;
}

describe("encrypted production backups", { timeout: 20_000 }, () => {
  it.each([false, true])(
    "streams every artifact through age without plaintext on disk (file: %s)",
    (fromFile) => {
      const f = fixture();
      const file = path.join(f.root, "recipients.txt");
      write(file, `# backup keys\n${recipients.split(" ").join("\n")}\n`);
      const result = f.run(
        "infra/compose/backup-prod.sh",
        [],
        fromFile
          ? { RAKAZO_BACKUP_AGE_RECIPIENTS_FILE: file }
          : { RAKAZO_BACKUP_AGE_RECIPIENTS: recipients },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("not encrypted");
      const snapshot = snapshotOf(result);
      expect(readdirSync(snapshot).sort()).toEqual([
        "SHA256SUMS",
        "SOURCE_SIZE_KB",
        "appdata.tgz.age",
        "rakazo.dump.age",
      ]);
      for (const name of ["rakazo.dump.age", "appdata.tgz.age"]) {
        const sealed = readFileSync(path.join(snapshot, name), "utf8");
        expect(sealed.startsWith("age-encryption.org/v1\n-> fake age1fakeprimary\n")).toBe(true);
        expect(sealed).toContain("-> fake age1fakerecovery");
      }
      expect(readFileSync(path.join(snapshot, "rakazo.dump.age"), "utf8")).not.toContain(
        "custom-format dump",
      );
      expect(readFileSync(path.join(snapshot, "SHA256SUMS"), "utf8")).toContain("rakazo.dump.age");
      expect(existsSync(path.join(f.snapshots, ".encrypted"))).toBe(true);

      // The drill runs where the private key lives and rejects any other identity.
      const key = path.join(f.root, "backup.key");
      write(key, identity);
      const drill = f.run("infra/compose/backup-drill.sh", [snapshot, key]);
      expect(drill.status, drill.stderr).toBe(0);
      expect(drill.stdout).toContain("decrypts and verifies");
      write(key, "# public key: age1someoneelse\n");
      expect(f.run("infra/compose/backup-drill.sh", [snapshot, key]).status).not.toBe(0);

      write(key, identity);
      write(path.join(snapshot, "appdata.tgz.age"), "age-encryption.org/v1\ntampered");
      expect(f.run("infra/compose/backup-drill.sh", [snapshot, key]).status).not.toBe(0);
    },
  );

  it.each([
    [{ RAKAZO_BACKUP_AGE_RECIPIENTS: "not-a-recipient" }, "age rejected"],
    [{ RAKAZO_BACKUP_AGE_RECIPIENTS_FILE: "/nonexistent/recipients" }, "not a readable"],
  ])("refuses broken recipient settings before any backup commands: %j", (settings, message) => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], settings);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(f.commands()).toEqual([]);
    expect(existsSync(f.snapshots)).toBe(false);
  });

  it("refuses plaintext after encryption was configured unless explicitly allowed", () => {
    const f = fixture();
    const first = f.run("infra/compose/backup-prod.sh", [], {
      RAKAZO_BACKUP_AGE_RECIPIENTS: recipients,
    });
    expect(first.status, first.stderr).toBe(0);
    const before = snapshotNames(f.snapshots).sort();
    const commandsBefore = f.commands().length;

    const refused = f.run("infra/compose/backup-prod.sh");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("refusing to write plaintext");
    expect(f.commands()).toHaveLength(commandsBefore);
    expect(snapshotNames(f.snapshots).sort()).toEqual(before);

    // A later stamp, so this run never collides with the first one's second.
    write(path.join(f.root, "bin/date"), "#!/bin/bash\necho 20991231T000000Z\n");
    chmodSync(path.join(f.root, "bin/date"), 0o755);
    const allowed = f.run("infra/compose/backup-prod.sh", [], {
      RAKAZO_BACKUP_ALLOW_PLAINTEXT: "1",
    });
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stderr).toContain("not encrypted");
    expect(existsSync(path.join(snapshotOf(allowed), "rakazo.dump"))).toBe(true);
  });

  it("does not publish a snapshot when sealing fails", () => {
    const f = fixture();
    // age accepts the recipients during preflight, then fails while writing.
    write(
      path.join(f.root, "bin/age"),
      `#!/bin/bash\n[[ "$*" != *" -o "* ]] || { cat >/dev/null; exit 1; }\n`,
    );
    const result = f.run("infra/compose/backup-prod.sh", [], {
      RAKAZO_BACKUP_AGE_RECIPIENTS: recipients,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Verified Rakazo backup");
    expect(snapshotNames(f.snapshots)).toEqual([]);
    expect(existsSync(path.join(f.snapshots, ".encrypted"))).toBe(false);
  });

  it.each<Record<string, string>>([{ FAIL_VERIFY: "1" }, { FAIL_TAR: "2" }])(
    "verifies the plaintext stream without the private key: %j",
    (failure) => {
      const f = fixture();
      const result = f.run("infra/compose/backup-prod.sh", [], {
        RAKAZO_BACKUP_AGE_RECIPIENTS: recipients,
        ...failure,
      });
      expect(result.status).not.toBe(0);
      expect(snapshotNames(f.snapshots)).toEqual([]);
    },
  );
});

describe("off-site copies", { timeout: 20_000 }, () => {
  const remote = "offsite:rakazo/";
  const remoteDir = (f: ReturnType<typeof fixture>) => path.join(f.env.FAKE_REMOTE, "rakazo");
  const rcloneCalls = (f: ReturnType<typeof fixture>) =>
    existsSync(f.env.RCLONE_LOG) ? readFileSync(f.env.RCLONE_LOG, "utf8").trim().split("\n") : [];

  it("uploads sealed files with checksums last and prunes only older remote snapshots", () => {
    const f = fixture();
    for (const stamp of ["20261014T000000Z", "20261015T000000Z", "20261016T000000Z"])
      write(path.join(remoteDir(f), stamp, "SHA256SUMS"), "sums");
    write(path.join(remoteDir(f), "20261017T000000Z/rakazo.dump.age"), "partial");
    write(path.join(remoteDir(f), "notes/keep.txt"), "not a snapshot");
    const result = f.run("infra/compose/backup-prod.sh", [], {
      RAKAZO_BACKUP_AGE_RECIPIENTS: recipients,
      RAKAZO_BACKUP_OFFSITE_REMOTE: remote,
      RAKAZO_BACKUP_OFFSITE_KEEP: "2",
    });
    expect(result.status, result.stderr).toBe(0);
    const stamp = path.basename(snapshotOf(result));
    expect(result.stdout).toContain(`Copied to offsite:rakazo/${stamp}`);
    expect(readdirSync(path.join(remoteDir(f), stamp)).sort()).toEqual(
      readdirSync(snapshotOf(result)).sort(),
    );
    expect(readdirSync(remoteDir(f)).sort()).toEqual(["20261016T000000Z", "notes", stamp].sort());
    const calls = rcloneCalls(f).map((line) => line.split(" ")[0]);
    expect(calls.slice(0, 3)).toEqual(["copy", "check", "copyto"]);
    expect(rcloneCalls(f)[2]).toContain(`${stamp}/SHA256SUMS`);
  });

  it("leaves remote retention to the destination when the off-site keep is 0", () => {
    const f = fixture();
    write(path.join(remoteDir(f), "20261014T000000Z/SHA256SUMS"), "sums");
    const result = f.run("infra/compose/backup-prod.sh", [], {
      RAKAZO_BACKUP_AGE_RECIPIENTS: recipients,
      RAKAZO_BACKUP_OFFSITE_REMOTE: remote,
      RAKAZO_BACKUP_OFFSITE_KEEP: "0",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(remoteDir(f), "20261014T000000Z"))).toBe(true);
    expect(rcloneCalls(f).some((line) => /^(lsf|purge) /.test(line))).toBe(false);
  });

  it.each([
    [{ FAIL_RCLONE: "copy" }, "upload"],
    [{ FAIL_RCLONE: "check" }, "verification"],
    [{ RAKAZO_BACKUP_AGE_RECIPIENTS: "" }, "off-site copies require RAKAZO_BACKUP_AGE_RECIPIENTS"],
  ])("keeps the verified local snapshot but fails the run: %j", (settings, message) => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], {
      RAKAZO_BACKUP_AGE_RECIPIENTS: recipients,
      RAKAZO_BACKUP_OFFSITE_REMOTE: remote,
      ...settings,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Verified Rakazo backup");
    expect(result.stderr).toContain(`Off-site copy failed: ${message}`);
    expect(existsSync(path.join(snapshotOf(result), "SHA256SUMS"))).toBe(true);
    if (message.includes("require")) expect(rcloneCalls(f)).toEqual([]);
    // An unverified remote copy never gets the completion marker retention counts.
    const copy = path.join(remoteDir(f), path.basename(snapshotOf(result)), "SHA256SUMS");
    expect(existsSync(copy)).toBe(false);
  });

  it("rejects an off-site retention that is not a whole number", () => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], { RAKAZO_BACKUP_OFFSITE_KEEP: "08" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RAKAZO_BACKUP_OFFSITE_KEEP");
  });
});

// Real age is optional locally and in CI; the fake above keeps the suite offline and deterministic.
const realAge = ["age", "age-keygen"].every(
  (tool) => spawnSync("/bin/sh", ["-c", `command -v ${tool}`]).status === 0,
);

describe.skipIf(!realAge)("encrypted production backups with real age", { timeout: 20_000 }, () => {
  it("round-trips through a real age identity", () => {
    const f = fixture();
    const tools = path.join(f.root, "real-age");
    mkdirSync(tools);
    for (const tool of ["age", "age-keygen"]) {
      const located = execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
      symlinkSync(located.trim(), path.join(tools, tool));
    }
    rmSync(path.join(f.root, "bin/age"));
    const key = path.join(f.root, "backup.key");
    execFileSync(path.join(tools, "age-keygen"), ["-o", key], { stdio: "ignore" });
    const recipient = execFileSync(path.join(tools, "age-keygen"), ["-y", key], {
      encoding: "utf8",
    }).trim();
    const PATH = `${tools}${path.delimiter}${f.env.PATH}`;
    const result = f.run("infra/compose/backup-prod.sh", [], {
      PATH,
      RAKAZO_BACKUP_AGE_RECIPIENTS: recipient,
    });
    expect(result.status, result.stderr).toBe(0);
    const snapshot = snapshotOf(result);
    const dump = execFileSync(
      path.join(tools, "age"),
      ["--decrypt", "-i", key, path.join(snapshot, "rakazo.dump.age")],
      { encoding: "utf8" },
    );
    expect(dump).toContain("fake custom-format dump");
    const drill = f.run("infra/compose/backup-drill.sh", [snapshot, key], { PATH });
    expect(drill.status, drill.stderr).toBe(0);
  });
});
