import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PageBrowserCommand, PageBrowserResult } from "@rakazo/adapter-kit";
import type { DriverRun, Submission } from "../page-browser-bench/tasks.js";
import {
  comparisonTable,
  LIVE_SITES,
  modelSize,
  runTask,
  SITE,
  TASKS,
} from "../page-browser-bench/tasks.js";

const USAGE = `Usage: pnpm bench:page-browser [options]
  --driver=installed|<git-ref>   Driver to measure; repeat to compare (default: installed)
  --image=<image>                Computer image for a fresh local container (default: rakazo/computer:local)
  --exec="<command prefix>"      Run in an existing computer instead, e.g. "docker exec -i my-computer"
  --repeat=<n>                   Runs of the suite per driver (default: 3)
  --live-sites                   Also size a few public pages (needs internet)
  --out=<file.json>              Results file (default: page-browser-bench.json)
  --compare <a.json> <b.json>... Print the table for saved results instead of running`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixtures = path.join(root, "packages/testkit/src/page-browser-bench/fixtures");
const DRIVER_SOURCE = "infra/sandboxes/computer/rakazo-page-browser";
const SECRETS_SOURCE = "infra/sandboxes/computer/page_secrets.py";
const WORK = "/tmp/page-browser-bench";

type Exec = (args: string[], stdin?: string, timeoutMs?: number) => Promise<string>;

function execIn(prefix: string[]): Exec {
  return (args, stdin, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const [bin = "", ...rest] = prefix;
      const child = spawn(bin, [...rest, ...args], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else
          reject(
            new Error(`${args.join(" ").slice(0, 120)} exited ${code}: ${stderr.slice(-500)}`),
          );
      });
      child.stdin.end(stdin ?? "");
    });
}

async function writeFile(exec: Exec, target: string, content: string | Buffer, mode = "644") {
  await exec(
    ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1" && chmod "$2" "$1"', "sh", target, mode],
    content as string,
  );
}

/** Fixtures served over HTTPS inside the computer, and a browser that accepts their self-signed certificate. */
async function prepareComputer(exec: Exec) {
  for (const name of readdirSync(fixtures)) {
    await writeFile(exec, `${WORK}/site/${name}`, readFileSync(path.join(fixtures, name), "utf8"));
  }
  await exec([
    "sh",
    "-c",
    `cd ${WORK} && openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=localhost -days 2 \
       -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -keyout key.pem -out cert.pem 2>/dev/null \
     && (pkill -f '^python3 site/server.py' || true) \
     && (setsid nohup python3 site/server.py cert.pem key.pem >server.log 2>&1 &) \
     && (pkill -f 'remote-debugging-port=922[2]' || true) && sleep 1 \
     && (DISPLAY=:1 RAKAZO_BROWSER_PROFILE=${WORK}/profile setsid nohup rakazo-browser \
           --ignore-certificate-errors ${SITE}/index.html >browser.log 2>&1 &) \
     && for i in $(seq 1 60); do curl -sf http://127.0.0.1:9222/json/version >/dev/null \
           && curl -skf ${SITE}/index.html >/dev/null && exit 0; sleep 0.5; done; exit 1`,
  ]);
}

/** The driver as committed at a git ref, copied into the computer next to its helpers. */
async function installDriver(exec: Exec, driver: string) {
  if (driver === "installed") return "/usr/local/bin/rakazo-page-browser";
  const sha = execFileSync("git", ["rev-parse", "--short", `${driver}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const directory = `${WORK}/drivers/${sha}`;
  // Before agent-browser the driver was one file; since, it imports page_secrets from its own folder.
  const files = execFileSync(
    "git",
    ["ls-tree", "--name-only", sha, DRIVER_SOURCE, SECRETS_SOURCE],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean);
  if (!files.includes(DRIVER_SOURCE)) throw new Error(`${driver} has no ${DRIVER_SOURCE}`);
  for (const file of files) {
    const content = execFileSync("git", ["show", `${sha}:${file}`], {
      cwd: root,
      encoding: "utf8",
    });
    await writeFile(
      exec,
      `${directory}/${path.basename(file)}`,
      content,
      file === DRIVER_SOURCE ? "755" : "644",
    );
  }
  return `${directory}/rakazo-page-browser`;
}

function driverRunner(exec: Exec, driverPath: string) {
  return async (command: PageBrowserCommand): Promise<PageBrowserResult> => {
    // The same environment and stdin arguments the supervisor gives the helper.
    const env = [
      "DISPLAY=:1",
      "RAKAZO_CDP_PORT=9222",
      "HOME=/home/rakazo",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "RAKAZO_BROWSER_ARGS_STDIN=1",
    ];
    try {
      const out = await exec(
        ["env", ...env, driverPath, command.command],
        `${JSON.stringify(command)}\n`,
        25_000,
      );
      return JSON.parse(out) as PageBrowserResult;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        fallback: "computer_act",
      };
    }
  };
}

async function measureDriver(
  exec: Exec,
  driver: string,
  repeat: number,
  live: boolean,
): Promise<DriverRun> {
  const run = driverRunner(exec, await installDriver(exec, driver));
  const submissions = async (runId: string) =>
    JSON.parse(await exec(["curl", "-sk", `${SITE}/__submissions?run=${runId}`])) as Submission[];
  // One unmeasured call starts the driver's own daemon, so the first task does not pay for it.
  await run({ command: "navigate", url: `${SITE}/index.html` });
  const result: DriverRun = { driver, tasks: [] };
  for (let pass = 1; pass <= repeat; pass += 1) {
    for (const task of TASKS) {
      const record = await runTask(task, randomUUID().slice(0, 8), run, submissions);
      result.tasks.push({ ...record, repeat: pass });
      console.error(
        `${driver} #${pass} ${task.id}: ${record.success ? "ok" : `FAIL (${record.failure})`}`,
      );
    }
  }
  if (live) {
    result.live = [];
    for (const url of LIVE_SITES) {
      const steps = [];
      for (const command of [
        { command: "navigate", url },
        { command: "snapshot" },
      ] as PageBrowserCommand[]) {
        const started = performance.now();
        const page = await run(command);
        steps.push({
          command: command.command,
          ms: Math.round(performance.now() - started),
          ok: page.ok,
          ...modelSize(page),
          ...(page.error ? { error: page.error.slice(0, 300) } : {}),
        });
      }
      result.live.push({ url, steps });
    }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const option = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (args.includes("--help")) return console.log(USAGE);
  if (args[0] === "--compare") {
    const runs = args
      .slice(1)
      .flatMap((file) => (JSON.parse(readFileSync(file, "utf8")) as { runs: DriverRun[] }).runs);
    return console.log(comparisonTable(runs));
  }
  const known = ["--driver=", "--image=", "--exec=", "--repeat=", "--out=", "--live-sites"];
  const unknown = args.filter((arg) => !known.some((prefix) => arg.startsWith(prefix)));
  if (unknown.length) throw new Error(`Unknown option ${unknown[0]}\n${USAGE}`);
  const drivers = args.filter((arg) => arg.startsWith("--driver=")).map((arg) => arg.slice(9));
  const repeat = Number(option("repeat") ?? 3);
  if (!Number.isInteger(repeat) || repeat < 1)
    throw new Error("--repeat must be a positive integer");
  const image = option("image") ?? "rakazo/computer:local";
  const out = option("out") ?? "page-browser-bench.json";

  let container: string | undefined;
  let prefix = option("exec")?.split(/\s+/).filter(Boolean);
  if (!prefix) {
    container = `page-browser-bench-${randomUUID().slice(0, 8)}`;
    execFileSync("docker", ["run", "-d", "--rm", "--name", container, "--shm-size=1g", image], {
      stdio: "ignore",
    });
    prefix = ["docker", "exec", "-i", container];
  }
  try {
    const exec = execIn(prefix);
    if (container)
      await exec([
        "sh",
        "-c",
        "for i in $(seq 1 100); do xdpyinfo -display :1 >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1",
      ]);
    await prepareComputer(exec);
    const runs: DriverRun[] = [];
    for (const driver of drivers.length ? drivers : ["installed"]) {
      runs.push(await measureDriver(exec, driver, repeat, args.includes("--live-sites")));
    }
    writeFileSync(
      out,
      `${JSON.stringify({ startedAt: new Date().toISOString(), target: container ? { image } : { exec: "custom" }, repeat, runs }, null, 2)}\n`,
    );
    console.log(comparisonTable(runs));
    console.log(`\nResults: ${out}`);
  } finally {
    if (container) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  }
}

await main();
