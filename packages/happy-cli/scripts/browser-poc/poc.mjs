#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const buildContext = resolve(root, "../..");
function validateRun(run) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(run || "")) throw new Error("run must be lowercase letters, digits and hyphens (max 40)");
  return run;
}
function resourceNames(run) {
  validateRun(run);
  return { network: `abp-${run}`, fixture: `abp-${run}-fixture`, browserA: `abp-${run}-browser-a`, browserB: `abp-${run}-browser-b`, runtime: `abp-${run}-runtime`, profileA: `abp-${run}-profile-a`, profileB: `abp-${run}-profile-b`, state: `abp-${run}-state`, fixtureData: `abp-${run}-fixture-data` };
}
function dockerLabels(run) {
  return ["--label", `ai.saycode.abp-run=${validateRun(run)}`];
}
const docker = (...args) => {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new Error(`docker ${args[0]} failed: ${String(error.stderr || "").trim().replace(/(HARNESS_TOKEN|ABP_VNC_PASSWORD)=[^\s]+/g, "$1=[redacted]")}`);
  }
};
const statePath = (run) => join(root, ".abp", run, "env.json");
function state(run) {
  const p = statePath(run);
  if (!existsSync(p)) throw new Error(`run ${run} is not up`);
  return JSON.parse(readFileSync(p, "utf8"));
}
function opt(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
}
// Loopback by default. ABP_PUBLISH_HOST=0.0.0.0 is for a separate execution machine whose
// harness/client runs elsewhere; every published port still needs its own token or password.
const PUBLISH_HOST = process.env.ABP_PUBLISH_HOST ?? "127.0.0.1";
// ABP_PORT_BASE pins host ports (runtime base, admin +1, control +2, noVNC a/b +3/+4) so a
// service configured with the Runtime URL still reaches it after the machine reboots.
// `up --viewer runtime` is the production viewer layout (D2): no noVNC/websockify is started or
// published; people reach the display only through the Runtime's /v1/viewer/websockify.
const PORT_BASE = process.env.ABP_PORT_BASE ? Number(process.env.ABP_PORT_BASE) : undefined;
const publish = (offset, internal) => `${PUBLISH_HOST}:${PORT_BASE === undefined ? "" : PORT_BASE + offset}:${internal}`;
function port(id, internal) {
  const text = docker("port", id, String(internal));
  const match = text.match(/(?:\d+\.){3}\d+:(\d+)/);
  if (!match) throw new Error(`missing localhost port for ${id}:${internal}`);
  return Number(match[1]);
}
// Parallel harness sessions may build their own images (ABP_IMAGE_TAG=<suffix>)
// so a rebuild in one session never swaps the image under another session's run.
const IMAGE_TAG = process.env.ABP_IMAGE_TAG || "poc";
const IMAGES = { fixture: `abp-fixture:${IMAGE_TAG}`, browser: `abp-browser:${IMAGE_TAG}`, runtime: `abp-runtime:${IMAGE_TAG}` };
function image(tag, file, rebuild) {
  if (rebuild || !docker("image", "ls", "-q", tag)) docker("build", "-f", join(root, "images", file), "-t", tag, buildContext);
}
function runContainer(name, run, args) {
  return docker("run", "-d", "--name", name, ...dockerLabels(run), ...args);
}
function allLabelled(run, kind) {
  return docker(kind, "ls", ...kind === "container" ? ["-a"] : [], "-q", "--filter", `label=ai.saycode.abp-run=${run}`).split("\n").filter(Boolean);
}
async function control(s, method, path, payload) {
  const res = await fetch(`http://127.0.0.1:${s.ports.control}${path}`, { method, headers: { "x-harness-token": s.harnessToken, ...payload ? { "content-type": "application/json" } : {} }, body: payload ? JSON.stringify(payload) : void 0 });
  if (!res.ok) throw new Error(`control ${res.status}`);
  return res.json();
}
function up(run, argv) {
  const names = resourceNames(run), rebuild = argv.includes("--rebuild"), runtimeBundle = opt(argv, "--runtime-bundle"), envFile = opt(argv, "--runtime-env"), keysFile = opt(argv, "--runtime-keys");
  const viewerMode = opt(argv, "--viewer", "harness");
  if (!["harness", "runtime"].includes(viewerMode)) throw new Error("--viewer must be harness or runtime");
  const harnessNoVnc = viewerMode === "harness";
  const labels = dockerLabels(run), network = names.network;
  // Each browser gets its own network: the Runtime and the fixture join both, but a
  // browser (or a page in it) can never reach the other profile's CDP endpoint.
  // No shared network: two per run keeps docker's default address pools from running out.
  const browserNetworks = { a: `${network}-a`, b: `${network}-b` };
  for (const net of Object.values(browserNetworks)) docker("network", "create", ...labels, net);
  for (const volume of [names.profileA, names.profileB, names.state, names.fixtureData]) docker("volume", "create", ...labels, volume);
  image(IMAGES.fixture, "fixture.Dockerfile", rebuild);
  image(IMAGES.browser, "browser.Dockerfile", rebuild);
  image(IMAGES.runtime, "runtime.Dockerfile", rebuild);
  const harnessToken = randomBytes(32).toString("hex");
  // RFB passwords are at most 8 characters.
  const vncPassword = randomBytes(6).toString("base64url").slice(0, 8);
  const fixture = runContainer(names.fixture, run, ["--network", browserNetworks.a, "--network-alias", "a.poc-one.test", "--network-alias", "b.poc-two.test", "--network-alias", "c.poc-three.test", "-p", publish(2, 9099), "-e", `HARNESS_TOKEN=${harnessToken}`, "-e", "FIXTURE_PORT=8080", "-e", "CONTROL_PORT=9099", "-v", `${names.fixtureData}:/var/lib/abp`, IMAGES.fixture]);
  docker("network", "connect", "--alias", "a.poc-one.test", "--alias", "b.poc-two.test", "--alias", "c.poc-three.test", browserNetworks.b, fixture);
  const browsers = {};
  for (const profile of ["a", "b"]) browsers[profile] = runContainer(names[profile === "a" ? "browserA" : "browserB"], run, ["--network", browserNetworks[profile], "--network-alias", `browser-${profile}`, "-e", `ABP_VNC_PASSWORD=${vncPassword}`, "-e", `ABP_CDP_HOST=browser-${profile}:9223`, "--read-only", "--tmpfs", "/tmp:rw,size=128m", "--tmpfs", "/run/abp:rw,uid=1000,gid=1000,size=1m", "--tmpfs", "/home/browser/.cache:rw,uid=1000,gid=1000,size=64m", "--tmpfs", "/home/browser/.config:rw,uid=1000,gid=1000,size=64m", "--tmpfs", "/home/browser/.local:rw,uid=1000,gid=1000,size=64m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512", "--memory", "2g", "--cpus", "2", "--shm-size", "256m", "-v", `${profile === "a" ? names.profileA : names.profileB}:/home/browser/profile`, "-e", "ABP_FIXTURE_ALIAS=a.poc-one.test", ...harnessNoVnc ? ["-e", "ABP_HARNESS_NOVNC=1", "-p", publish(profile === "a" ? 3 : 4, 6080)] : [], IMAGES.browser]);
  let runtime;
  if (runtimeBundle) {
    const env = envFile ? JSON.parse(readFileSync(resolve(envFile), "utf8")) : {};
    const args = ["--network", browserNetworks.a, "--network-alias", "runtime", "--read-only", "--tmpfs", "/tmp:rw,size=64m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "1g", "--cpus", "1", "-v", `${names.state}:/var/lib/abp`, "-v", `${resolve(runtimeBundle)}:/app/runtime.mjs:ro`, "-p", publish(0, 8787), "-p", publish(1, 8788)];
    if (keysFile) args.push("-v", `${resolve(keysFile)}:/app/keys.json:ro`);
    // The Runtime's viewer proxy authenticates to x11vnc on the profile networks.
    args.push("-e", `ABP_VNC_PASSWORD=${vncPassword}`);
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    runtime = runContainer(names.runtime, run, [...args, IMAGES.runtime]);
    docker("network", "connect", "--alias", "runtime", browserNetworks.b, runtime);
  }
  const s = { run, names, containers: { fixture, browserA: browsers.a, browserB: browsers.b, ...runtime ? { runtime } : {} }, ports: { control: port(fixture, 9099), ...harnessNoVnc ? { novncA: port(browsers.a, 6080), novncB: port(browsers.b, 6080) } : {}, ...runtime ? { runtime: port(runtime, 8787), admin: port(runtime, 8788) } : {} }, harnessToken, vncPassword, viewer: viewerMode, runtimeBundle: runtimeBundle ? resolve(runtimeBundle) : void 0, runtimeEnv: envFile ? resolve(envFile) : void 0 };
  const path = statePath(run);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2), { mode: 384 });
  return { run, containers: s.containers, ports: s.ports, envFile: path };
}
function down(run, purge) {
  const names = resourceNames(run);
  for (const id of allLabelled(run, "container")) docker("rm", "-f", id);
  for (const id of allLabelled(run, "network")) docker("network", "rm", id);
  if (purge) for (const id of allLabelled(run, "volume")) docker("volume", "rm", id);
  rmSync(statePath(run), { force: true });
  return { down: true, volumesKept: !purge, names };
}
function fault(run, argv) {
  const kind = argv[0], profile = opt(argv, "--profile", "a");
  if (!["a", "b"].includes(profile)) throw new Error("profile must be a or b");
  const s = state(run), browser = s.containers[profile === "a" ? "browserA" : "browserB"];
  if (kind === "kill-chrome") docker("exec", browser, "pkill", "-f", "/usr/lib/chromium/chromium");
  else if (kind === "restart-browser-container") docker("restart", browser);
  else if (kind === "restart-runtime") docker("restart", s.containers.runtime);
  else if (kind === "kill-runtime") docker("kill", s.containers.runtime);
  else if (kind === "start-runtime") docker("start", s.containers.runtime);
  else if (kind === "pause-runtime") docker("pause", s.containers.runtime);
  else if (kind === "unpause-runtime") docker("unpause", s.containers.runtime);
  else throw new Error(`unknown fault ${kind}`);
  return { fault: kind, profile };
}
async function main(argv = process.argv.slice(2)) {
  const [cmd, ...args] = argv, run = validateRun(opt(args, "--run"));
  if (cmd === "up") {
    try {
      return up(run, args);
    } catch (error) {
      // A half-created run (e.g. network creation failed) must not leak containers or
      // networks: every later run would inherit the exhausted address pool.
      try { down(run, false); } catch {}
      throw error;
    }
  }
  if (cmd === "down") return down(run, args.includes("--purge"));
  if (cmd === "ps") return { containers: allLabelled(run, "container"), networks: allLabelled(run, "network"), volumes: allLabelled(run, "volume") };
  if (cmd === "fault") return fault(run, args.slice(0, 1).concat(args.slice(1)));
  const s = state(run);
  if (cmd === "health") {
    const fixture = await control(s, "GET", "/control/health");
    const runtime = s.ports.runtime ? await fetch(`http://127.0.0.1:${s.ports.runtime}/v1/health`).then((r) => ({ status: r.status })) : void 0;
    return { fixture, runtime, ports: s.ports };
  }
  if (cmd === "ledger") return control(s, "GET", `/control/ledger?run=${encodeURIComponent(run)}`);
  if (cmd === "release-barrier") return control(s, "POST", "/control/barrier/release", { run, key: opt(args, "--key"), nonce: opt(args, "--nonce") });
  throw new Error(`unknown command ${cmd}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((x) => console.log(JSON.stringify(x, null, 2))).catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
export {
  dockerLabels,
  main,
  resourceNames,
  validateRun
};
