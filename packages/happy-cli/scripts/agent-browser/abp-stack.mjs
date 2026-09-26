#!/usr/bin/env node
// abp-stack — operate the Agent Browser stack on execution machine H (spec D11).
// Installed by abp-install as /usr/local/sbin/abp-stack (root only).
//
//   abp-stack up | down | status [--json]
//   abp-stack emergency-stop                                      (no lock, no drain; incidents only)
//   abp-stack upgrade (--images <dir> | --runtime-image <sha256:…> --browser-image <sha256:…>) [--ready-timeout <s>]
//   abp-stack rollback [--ready-timeout <s>]
//   abp-stack rotate-keys [--daemon-token] [--vnc-password]      (both when neither is given)
//   abp-stack set-principal <profileId> <principalId>
//   abp-stack load <dir> [--set-initial]                          (docker load + digest check)
//   abp-stack build --source <happy-cli dir> [--out <dir>] [--tag <tag>] [--set-initial]
//   abp-stack run                                                 (abp-stack.service only)
//
// Containers, networks and volumes carry the label ai.saycode.abp=stack. Images
// are referenced only by content digest (sha256:…); /var/lib/abp/stack-state.json
// records the current and previous digests. Volumes (abp-state, abp-profile-*)
// are never removed here; see abp-uninstall --purge.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fchownSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PATHS, STACK_LABEL, browserCreateArgs, fenceRule, mergeInstallOptions, networkCreateArgs, runtimeConfig, runtimeCreateArgs, stackLayout } from "./lib/abpPlan.mjs";

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const IMAGE_LABEL = '{{index .Config.Labels "ai.saycode.abp.image"}}';
const RESTART_BACKOFF_MS = { first: 2_000, max: 60_000, resetAfterRunningMs: 60_000 };
const DEFAULT_READY_TIMEOUT_MS = 180_000;
const DEFAULT_DRAIN_MS = 60_000;
const EGRESS_CHECK_INTERVAL_MS = 10_000;
const FIREWALL = `${PATHS.libexec}/abp-firewall`;
/** Set by emergency-stop so the service stop skips the drain; removed by the next start. */
const EMERGENCY_FLAG = "/run/abp-stack-emergency";
/**
 * Set (with its time) while an upgrade or rollback replaces single containers of the running stack, so
 * the supervisor does not restart the container being replaced. Older than MAINTENANCE_MAX_MS = left
 * behind by a crashed operation, and ignored.
 */
const MAINTENANCE_FLAG = "/run/abp-stack-maintenance";
const MAINTENANCE_MAX_MS = 15 * 60_000;
const NETWORK_FORMAT = '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}} {{index .Options "com.docker.network.bridge.name"}}';
const SERVICE = "abp-stack.service";
const DAEMON_SERVICE = "abp-happy-daemon.service";
const SECRET_FILES = {
  runtimeVnc: { path: `${PATHS.runtimeSecrets}/vnc-password`, mode: 0o440, owner: "abp-runtime", group: "root" },
  browserVnc: { path: `${PATHS.browserSecrets}/vnc-password`, mode: 0o400, owner: "abp-browser", group: "abp-browser" },
  daemonToken: { path: PATHS.daemonToken, mode: 0o400, owner: "agent", group: "agent" },
};

/** Real host: docker/systemctl through spawnSync, atomic root-owned writes, loopback readiness. */
function unixJson(socketPath, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET", headers, timeout: 3_000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => { try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : undefined }); } catch { resolve({ status: res.statusCode }); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

export function systemDeps() {
  const lookup = (args) => {
    const result = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
    const value = Number(String(result.stdout).trim().split(":")[2] ?? String(result.stdout).trim());
    if (result.status !== 0 || !Number.isInteger(value)) throw new Error(`unknown account ${args.at(-1)}`);
    return value;
  };
  const uidOf = (name) => (name === "root" ? 0 : lookup(["id", "-u", name]));
  const gidOf = (name) => (name === "root" ? 0 : lookup(["getent", "group", name]));
  return {
    run(cmd, args, { allowFail = false, input } = {}) {
      const result = spawnSync(cmd, args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
      if (result.error) throw new Error(`${cmd} could not run: ${result.error.code ?? result.error.message}`);
      const out = { status: result.status ?? 1, stdout: String(result.stdout).trim(), stderr: String(result.stderr).trim() };
      // Our docker arguments carry no secret (passwords and tokens are files), so stderr can be shown.
      if (out.status !== 0 && !allowFail) throw new Error(`${cmd} ${args[0]} failed (status ${out.status}): ${out.stderr.split("\n").slice(-3).join(" ")}`);
      return out;
    },
    readFile: (path) => readFileSync(path, "utf8"),
    exists: (path) => existsSync(path),
    writeFileAtomic(path, data, { mode, owner, group }) {
      const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}`);
      const fd = openSync(tmp, "wx", mode);
      try {
        writeSync(fd, data);
        fchownSync(fd, uidOf(owner), gidOf(group));
        fsyncSync(fd);
      } catch (error) {
        closeSync(fd);
        rmSync(tmp, { force: true });
        throw error;
      }
      closeSync(fd);
      renameSync(tmp, path);
      const dir = openSync(dirname(path), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    },
    groupId: gidOf,
    async ready(port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/ready`, { signal: AbortSignal.timeout(3_000) });
        return { status: response.status, body: await response.json().catch(() => undefined) };
      } catch {
        return { status: 0 };
      }
    },
    /** Admin metrics over the root-only admin socket; undefined when the Runtime does not answer. */
    adminMetrics: () => unixJson(PATHS.adminSocket, "/admin/metrics", {}).then((reply) => (reply.status === 200 ? reply.body?.result : undefined), () => undefined),
    /** Status of an authenticated, read-only broker call made with the given daemon token (200 = accepted). */
    brokerProbe: (token) => unixJson(PATHS.brokerSocket, "/v1/attention?afterSeq=0&waitMs=0", { "x-abp-daemon-token": token }).then((reply) => reply.status, () => 0),
    /**
     * Kernel flock on PATHS.opsLock held by a child for the operation; it is released when the
     * operation ends or this process dies. abp-install holds the same lock and marks its children.
     */
    async opLock() {
      if (process.env.ABP_STACK_OPS_LOCKED === "1") return () => {};
      const child = spawn("flock", ["-n", "-E", "73", PATHS.opsLock, "sh", "-c", "echo locked; exec cat >/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
      const held = await new Promise((resolve) => {
        child.stdout.once("data", () => resolve(true));
        child.once("exit", () => resolve(false));
        child.once("error", () => resolve(false));
      });
      if (!held) throw new Error("another abp-stack operation (or abp-install) is running");
      return () => child.stdin.end();
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    log: (line) => process.stderr.write(`[abp-stack] ${new Date().toISOString()} ${line}\n`),
    secret: (kind) => (kind === "vnc-password" ? randomBytes(6).toString("base64url") : randomBytes(32).toString("hex")),
    tempDir: () => mkdtempSync(join(tmpdir(), "abp-build-")),
    copyFile: (from, to) => copyFileSync(from, to),
    mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o755 }),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
  };
}

export function createStack(deps) {
  const docker = (args, opts) => deps.run("docker", args, opts);
  const systemctl = (args, opts) => deps.run("systemctl", args, opts);
  const firewall = (args, opts) => deps.run(FIREWALL, args, opts);
  const iptables = (args, opts) => deps.run("iptables", ["-w", "-t", "filter", ...args], opts);
  const readJson = (path) => JSON.parse(deps.readFile(path));
  const install = () => readJson(PATHS.installConfig);
  const layout = () => stackLayout(install());
  const readState = () => (deps.exists(PATHS.stackState) ? readJson(PATHS.stackState) : { schemaVersion: 1, current: null, previous: null, history: [] });
  const writeState = (state) => deps.writeFileAtomic(PATHS.stackState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, owner: "root", group: "root" });
  const record = (state, entry) => ({ ...state, history: [...state.history, { atMs: deps.now(), ...entry }].slice(-50) });
  let lastEgressCheckMs = -Infinity;

  /** Mutating operations are serialized (upgrade, rollback, rotate-keys, set-principal, and abp-install). */
  async function locked(fn) {
    const release = await deps.opLock();
    try { return await fn(); } finally { release(); }
  }

  function assertImages(ids) {
    for (const role of ["runtime", "browser"]) {
      if (!IMAGE_ID.test(ids?.[role] ?? "")) throw new Error(`${role} image must be a content digest (sha256:<64 hex>)`);
      const found = docker(["image", "inspect", "--format", "{{.Id}}", ids[role]], { allowFail: true });
      if (found.status !== 0) throw new Error(`${role} image ${ids[role]} is not loaded`);
      if (found.stdout !== ids[role]) throw new Error(`${role} image digest mismatch`);
    }
  }

  /** Browsers may run only while the egress firewall is live; a missing one is re-applied once. */
  function egressInPlace() {
    if (firewall(["check-egress"], { allowFail: true }).status === 0) return true;
    deps.log("browser egress firewall missing or changed; re-applying it");
    firewall(["apply-egress"], { allowFail: true });
    return firewall(["check-egress"], { allowFail: true }).status === 0;
  }

  /** Regenerates runtime.json from install.json, keeping the resolved machine id and (unless given) the token hash. */
  function writeRuntimeConfig(options, daemonTokenSha256) {
    const existing = deps.exists(PATHS.runtimeConfig) ? readJson(PATHS.runtimeConfig) : {};
    const machineId = options.machineId !== "auto" ? options.machineId : existing.machineId;
    if (!machineId) throw new Error("machineId is unresolved; run abp-install after the agent's Happy login");
    const config = runtimeConfig({ ...options, machineId }, { sessionGid: deps.groupId("abp-session"), daemonTokenSha256: daemonTokenSha256 ?? existing.daemonTokenSha256 });
    deps.writeFileAtomic(PATHS.runtimeConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, owner: "root", group: "root" });
  }

  /**
   * Admission fence: host packets to the Runtime API are reset (new tasks and requests on kept-alive
   * connections alike). Verified three ways: the rule is in ABP-FENCE, OUTPUT jumps to ABP-FENCE,
   * and the API really no longer answers.
   */
  async function fence() {
    const { runtimePort } = layout();
    iptables(["-F", "ABP-FENCE"], { allowFail: true });
    if (iptables(["-A", "ABP-FENCE", ...fenceRule(runtimePort)], { allowFail: true }).status !== 0) return { ok: false, reason: "fence rule not installed" };
    if (iptables(["-C", "OUTPUT", "-j", "ABP-FENCE"], { allowFail: true }).status !== 0) return { ok: false, reason: "OUTPUT does not jump to ABP-FENCE" };
    if ((await deps.ready(runtimePort)).status !== 0) return { ok: false, reason: "the Runtime API still answers behind the fence" };
    return { ok: true };
  }

  /** Waits for running/recovering tasks to reach 0: result drained | timeout | unavailable (admin metrics do not answer). */
  async function drain(drainMs) {
    const startedMs = deps.now();
    for (;;) {
      const metrics = await deps.adminMetrics();
      const waitedMs = deps.now() - startedMs;
      if (!metrics?.tasks) return { result: "unavailable", waitedMs };
      const running = (metrics.tasks.running ?? 0) + (metrics.tasks.recovering ?? 0);
      if (running === 0) return { result: "drained", running, waitedMs };
      if (waitedMs >= drainMs) return { result: "timeout", running, waitedMs };
      deps.log(`draining: ${running} running task(s)`);
      await deps.sleep(1_000);
    }
  }

  /**
   * Controlled operations (upgrade, rollback, rotate-keys, set-principal): a verified fence and a complete
   * drain, or the operation is aborted with nothing stopped or changed and the fence lifted.
   * A Runtime that is not running admits nothing, so it counts as quiesced (recorded as such).
   */
  async function quiesce(action) {
    const { runtime } = layout();
    const abort = (reason, detail) => {
      iptables(["-F", "ABP-FENCE"], { allowFail: true });
      writeState(record(readState(), { action, result: "aborted", reason, ...detail }));
      throw new Error(`${action} aborted: ${reason}; nothing was stopped or changed (abp-stack emergency-stop stops regardless)`);
    };
    let state;
    try { state = containerState(runtime.container); } catch (error) { abort(error.message); }
    if (state !== "running") return { fence: "not-needed", drain: { result: "runtime-not-running" } };
    const fenced = await fence();
    if (!fenced.ok) abort(fenced.reason);
    const drained = await drain(DEFAULT_DRAIN_MS);
    if (drained.result !== "drained") abort(`drain ${drained.result}${drained.running ? ` (${drained.running} running)` : ""}`, { drain: drained });
    deps.log(`${action}: fence verified, drained in ${drained.waitedMs} ms`);
    return { fence: "verified", drain: drained };
  }

  /** Service stop (SIGTERM, reboot): cannot be refused, so fence and drain are best effort and logged. */
  async function fenceAndDrainBestEffort(drainMs) {
    const fenced = await fence();
    deps.log(fenced.ok ? "stop: fence verified" : `stop: fence not verified (${fenced.reason}); stopping anyway`);
    if (drainMs <= 0) return;
    const drained = await drain(drainMs);
    deps.log(drained.result === "drained" ? `stop: drained in ${drained.waitedMs} ms`
      : `stop: drain ${drained.result}${drained.running ? ` with ${drained.running} running task(s); they recover paused on the next start` : ""}`);
  }
  const unfence = () => iptables(["-F", "ABP-FENCE"]);

  /**
   * running | stopped | absent (Docker says the container does not exist). Anything else (Docker
   * unreachable, permission, unexpected output) is an unknown state and throws: callers must not
   * treat it as "not running".
   */
  function containerState(name) {
    const result = docker(["inspect", "-f", "{{.State.Running}}", name], { allowFail: true });
    if (result.status === 0 && result.stdout === "true") return "running";
    if (result.status === 0 && result.stdout === "false") return "stopped";
    if (result.status !== 0 && /No such (object|container)/i.test(result.stderr ?? "")) return "absent";
    const why = result.status === 0 ? "unexpected output" : (result.stderr ?? "").split("\n")[0] || `status ${result.status}`;
    throw new Error(`cannot determine whether ${name} is running (docker inspect: ${why})`);
  }

  /** A container that ignores stop is killed; one that survives that, or whose state cannot be read, is an error. */
  function ensureStopped(name) {
    if (containerState(name) !== "running") return;
    deps.log(`${name} still running after stop; killing it`);
    docker(["kill", name], { allowFail: true });
    if (containerState(name) === "running") throw new Error(`${name} is still running`);
  }

  /** Every stack container is down (verified). */
  function verifyStopped() {
    const plan = layout();
    for (const name of [plan.runtime.container, ...plan.browsers.map((browser) => browser.container)]) ensureStopped(name);
  }

  async function waitReady(runtimeImage, timeoutMs) {
    const deadline = deps.now() + timeoutMs;
    const { runtimePort, runtime } = layout();
    let last;
    while (deps.now() < deadline) {
      // The Runtime answering must be the one started from the expected digest.
      const label = docker(["inspect", "-f", IMAGE_LABEL, runtime.container], { allowFail: true });
      if (label.status === 0 && label.stdout === runtimeImage) {
        last = await deps.ready(runtimePort);
        if (last.status === 200) return { ok: true, body: last.body };
      }
      await deps.sleep(1_000);
    }
    return { ok: false, body: last?.body };
  }

  /** Runtime restart after quiesce() (configuration or secret change); throws unless the same digest is ready again. */
  async function restartQuiescedRuntime(readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS) {
    const { runtime } = layout();
    const restarted = docker(["restart", "-t", "30", runtime.container], { allowFail: true }).status === 0;
    // The fence covers every host packet to the API port, the readiness probe included: lift it first.
    iptables(["-F", "ABP-FENCE"], { allowFail: true });
    if (!restarted) throw new Error("docker restart failed for the Runtime");
    const ready = await waitReady(readState().current?.runtime, readyTimeoutMs);
    if (!ready.ok) throw new Error("the restarted Runtime is not ready (abp-stack status)");
  }

  function createAndStartBrowser(plan, browser, image) {
    docker(browserCreateArgs(plan, browser, image));
    docker(["start", browser.container]);
  }

  function createAndStartRuntime(plan, image) {
    docker(runtimeCreateArgs(plan, image));
    for (const { network, ip } of plan.runtime.attach) docker(["network", "connect", `--alias=${plan.runtime.alias}`, `--ip=${ip}`, network, plan.runtime.container]);
    docker(["start", plan.runtime.container]);
  }

  /** Stops one container (killed if it ignores stop) and removes it; throws if it cannot be stopped. */
  function stopAndRemove(name, seconds) {
    docker(["stop", "-t", String(seconds), name], { allowFail: true });
    ensureStopped(name);
    docker(["rm", "-f", name], { allowFail: true });
  }

  /**
   * Running stack (the stack's fence and drain are already in place): replaces only the containers whose
   * running image differs from the target, browsers first, then the Runtime. A Runtime-only change keeps
   * the browsers with their profile, open pages and anything a pending approval refers to; a browser-only
   * change keeps the Runtime, which reconnects to the new browsers. The supervisor pauses meanwhile.
   */
  async function replaceChanged(target, previous, action, readyTimeoutMs, quiesced) {
    const before = readState();
    const plan = layout();
    const differs = (name, image) => {
      const [running, label] = docker(["inspect", "-f", `{{.State.Running}} ${IMAGE_LABEL}`, name], { allowFail: true }).stdout.split(" ");
      return running !== "true" || label !== image;
    };
    const browsers = plan.browsers.filter((browser) => differs(browser.container, target.browser));
    const runtime = differs(plan.runtime.container, target.runtime);
    const replaced = [...browsers.length ? ["browser"] : [], ...runtime ? ["runtime"] : []];
    const detail = { replaced, ...quiesced ? { quiesce: quiesced } : {} };
    deps.writeFileAtomic(MAINTENANCE_FLAG, String(deps.now()), { mode: 0o600, owner: "root", group: "root" });
    try {
      if (browsers.length && !egressInPlace()) throw new Error("browser egress firewall is not in place");
      if (runtime) stopAndRemove(plan.runtime.container, 30);
      for (const browser of browsers) {
        stopAndRemove(browser.container, 10);
        createAndStartBrowser(plan, browser, target.browser);
      }
      if (runtime) createAndStartRuntime(plan, target.runtime);
      writeState({ ...readState(), current: target, previous });
      unfence();
      const ready = await waitReady(target.runtime, readyTimeoutMs);
      writeState(record(readState(), { action, from: before.current, to: target, result: ready.ok ? "ready" : "not-ready", ready: ready.body, ...detail }));
      return { ok: ready.ok, ready: ready.body, before };
    } catch (error) {
      writeState(record(readState(), { action, from: before.current, to: target, result: "failed", error: error instanceof Error ? error.message : "failed", ...detail }));
      return { ok: false, before };
    } finally {
      if (deps.exists(MAINTENANCE_FLAG)) deps.remove(MAINTENANCE_FLAG);
    }
  }

  /**
   * Switches the stack to the target digests. On a running stack only the changed containers are
   * replaced (replaceChanged); otherwise the stack is stopped, verified down and started with them.
   */
  async function switchTo(target, previous, action, readyTimeoutMs, quiesced) {
    if (systemctl(["is-active", SERVICE], { allowFail: true }).stdout === "active") return replaceChanged(target, previous, action, readyTimeoutMs, quiesced);
    const before = readState();
    try {
      systemctl(["stop", SERVICE]);
      verifyStopped();
      writeState({ ...readState(), current: target, previous });
      systemctl(["start", SERVICE]);
      const ready = await waitReady(target.runtime, readyTimeoutMs);
      writeState(record(readState(), { action, from: before.current, to: target, result: ready.ok ? "ready" : "not-ready", ready: ready.body, ...quiesced ? { quiesce: quiesced } : {} }));
      return { ok: ready.ok, ready: ready.body, before };
    } catch (error) {
      writeState(record(readState(), { action, from: before.current, to: target, result: "failed", error: error instanceof Error ? error.message : "failed", ...quiesced ? { quiesce: quiesced } : {} }));
      return { ok: false, before };
    }
  }

  const stack = {
    locked,
    /** Recreates the stack containers from the current digests (volumes kept) behind a live egress firewall, then lifts the fence. */
    async start() {
      const state = readState();
      if (!state.current) throw new Error("no images installed (abp-install --images/--build-from, or abp-stack load --set-initial)");
      if (!egressInPlace()) throw new Error("browser egress firewall is not in place (abp-firewall check-egress); not starting");
      if (deps.exists(EMERGENCY_FLAG)) deps.remove(EMERGENCY_FLAG);
      const plan = layout();
      const old = docker(["ps", "-aq", "--filter", `label=${STACK_LABEL}`]).stdout.split("\n").filter(Boolean);
      if (old.length) docker(["rm", "-f", ...old]);
      for (const browser of plan.browsers) {
        const found = docker(["network", "inspect", "-f", NETWORK_FORMAT, browser.network], { allowFail: true });
        if (found.status === 0 && found.stdout === `${browser.subnet} ${browser.gateway} ${browser.bridge}`) continue;
        if (found.status === 0) docker(["network", "rm", browser.network]);
        docker(networkCreateArgs(browser));
      }
      for (const volume of plan.volumes) {
        if (docker(["volume", "inspect", volume], { allowFail: true }).status !== 0) docker(["volume", "create", `--label=${STACK_LABEL}`, volume]);
      }
      for (const browser of plan.browsers) createAndStartBrowser(plan, browser, state.current.browser);
      createAndStartRuntime(plan, state.current.runtime);
      unfence();
      lastEgressCheckMs = deps.now();
      deps.log(`started runtime=${state.current.runtime} browser=${state.current.browser} profiles=${plan.browsers.length}`);
    },

    /**
     * One supervision pass: the egress firewall is re-checked every 10 s (browsers are stopped while it
     * is missing and cannot be restored), exited containers are restarted with exponential backoff
     * (exit 75 = writer lock held).
     */
    superviseOnce(backoff) {
      const plan = layout();
      if (deps.exists(MAINTENANCE_FLAG) && deps.now() - Number(deps.readFile(MAINTENANCE_FLAG)) < MAINTENANCE_MAX_MS) return;
      if (deps.now() - lastEgressCheckMs >= EGRESS_CHECK_INTERVAL_MS) {
        if (!egressInPlace()) {
          deps.log("browser egress firewall missing and not restorable; browsers stopped until it is back");
          for (const browser of plan.browsers) docker(["stop", "-t", "10", browser.container], { allowFail: true });
          return;
        }
        lastEgressCheckMs = deps.now();
      }
      for (const name of [...plan.browsers.map((browser) => browser.container), plan.runtime.container]) {
        const entry = backoff.get(name) ?? { delayMs: 0, nextAtMs: 0, runningSinceMs: undefined };
        const [running, status] = docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name], { allowFail: true }).stdout.split(" ");
        if (running === "true") {
          entry.runningSinceMs ??= deps.now();
          if (deps.now() - entry.runningSinceMs >= RESTART_BACKOFF_MS.resetAfterRunningMs) entry.delayMs = 0;
        } else {
          entry.runningSinceMs = undefined;
          if (deps.now() >= entry.nextAtMs) {
            deps.log(`${name} exited status=${status || "missing"}; starting (backoff ${entry.delayMs} ms)`);
            docker(["start", name], { allowFail: true });
            entry.delayMs = Math.min(entry.delayMs ? entry.delayMs * 2 : RESTART_BACKOFF_MS.first, RESTART_BACKOFF_MS.max);
            entry.nextAtMs = deps.now() + entry.delayMs;
          }
        }
        backoff.set(name, entry);
      }
    },

    /**
     * Service stop: fence and drain (best effort; no drain after emergency-stop), stop the Runtime
     * (running tasks recover paused), then the browsers; verified. The fence stays until start.
     */
    async stop({ drainMs = DEFAULT_DRAIN_MS } = {}) {
      const plan = layout();
      await fenceAndDrainBestEffort(deps.exists(EMERGENCY_FLAG) ? 0 : drainMs);
      docker(["stop", "-t", "30", plan.runtime.container], { allowFail: true });
      for (const browser of plan.browsers) docker(["stop", "-t", "10", browser.container], { allowFail: true });
      verifyStopped();
    },

    /**
     * Incident path: no lock (a hung operation may hold it), best-effort fence, no drain (running tasks
     * recover paused or uncertain), service and containers stopped at once and verified down.
     */
    async emergencyStop() {
      const plan = layout();
      deps.writeFileAtomic(EMERGENCY_FLAG, "", { mode: 0o600, owner: "root", group: "root" });
      iptables(["-F", "ABP-FENCE"], { allowFail: true });
      iptables(["-A", "ABP-FENCE", ...fenceRule(plan.runtimePort)], { allowFail: true });
      systemctl(["stop", SERVICE], { allowFail: true });
      docker(["stop", "-t", "10", plan.runtime.container], { allowFail: true });
      for (const browser of plan.browsers) docker(["stop", "-t", "5", browser.container], { allowFail: true });
      verifyStopped();
      writeState(record(readState(), { action: "emergency-stop", result: "stopped" }));
      deps.log("emergency stop: stack down; abp-stack up to start again");
    },

    load(dir) {
      const manifest = readJson(join(dir, "manifest.json"));
      docker(["load", "-i", join(dir, "images.tar")]);
      const ids = { runtime: manifest.runtime?.id, browser: manifest.browser?.id };
      assertImages(ids);
      return ids;
    },

    /** First install only: an existing current digest is changed by upgrade, never here. */
    setInitialImages(ids) {
      assertImages(ids);
      const state = readState();
      if (state.current && (state.current.runtime !== ids.runtime || state.current.browser !== ids.browser)) {
        deps.log("images already installed; use abp-stack upgrade to switch digests");
        return state.current;
      }
      if (!state.current) writeState(record({ ...state, current: ids }, { action: "install", to: ids, result: "recorded" }));
      return ids;
    },

    upgrade({ images, ids, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS }) {
      return locked(async () => {
        const target = images ? stack.load(images) : ids;
        assertImages(target);
        const state = readState();
        if (!state.current) throw new Error("no current images; install first");
        if (state.current.runtime === target.runtime && state.current.browser === target.browser) return { changed: false };
        const quiesced = await quiesce("upgrade");
        const switched = await switchTo(target, state.current, "upgrade", readyTimeoutMs, quiesced);
        if (switched.ok) return { changed: true, ready: switched.ready };
        deps.log("upgrade: new stack failed or not ready; rolling back to the previous digests (volumes kept)");
        const back = await switchTo(state.current, state.previous, "auto-rollback", readyTimeoutMs);
        throw new Error(back.ok ? "upgrade failed: rolled back to the previous digests"
          : "upgrade failed and the rolled back stack is not ready either; see abp-stack status and journalctl -u abp-stack");
      });
    },

    rollback({ readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
      return locked(async () => {
        const state = readState();
        if (!state.previous) throw new Error("no previous digests recorded");
        assertImages(state.previous);
        const quiesced = await quiesce("rollback");
        const switched = await switchTo(state.previous, state.current, "rollback", readyTimeoutMs, quiesced);
        if (!switched.ok) throw new Error("rollback: Runtime not ready (a journal from a newer schema is refused on purpose); see abp-stack status");
        return { ready: switched.ready };
      });
    },

    /**
     * Daemon token: new file for agent, its hash into runtime.json, fenced Runtime restart (sessions keep
     * their registered secrets; running tasks recover paused), the broker must accept the new token, then
     * the daemon restarts (sessions stay alive) and must be active.
     * VNC password: both copies rewritten, x11vnc restarted inside each browser (Chromium keeps running) and
     * checked, fenced Runtime restart. Any failure is reported (history "failed"); rerun to complete.
     */
    rotateKeys({ daemonToken = true, vncPassword = true } = {}) {
      return locked(async () => {
        const done = [daemonToken && "daemon-token", vncPassword && "vnc-password"].filter(Boolean).join(",");
        const quiesced = await quiesce("rotate-keys");
        try {
          let token;
          if (daemonToken) {
            token = deps.secret("daemon-token");
            writeRuntimeConfig(install(), createHash("sha256").update(token).digest("hex"));
            deps.writeFileAtomic(SECRET_FILES.daemonToken.path, token, SECRET_FILES.daemonToken);
          }
          if (vncPassword) {
            const password = deps.secret("vnc-password");
            deps.writeFileAtomic(SECRET_FILES.runtimeVnc.path, password, SECRET_FILES.runtimeVnc);
            deps.writeFileAtomic(SECRET_FILES.browserVnc.path, password, SECRET_FILES.browserVnc);
            for (const browser of layout().browsers) docker(["exec", browser.container, "pkill", "-x", "x11vnc"], { allowFail: true });
          }
          await restartQuiescedRuntime();
          if (vncPassword) {
            for (const browser of layout().browsers) {
              let back = false;
              for (let attempt = 0; attempt < 20 && !back; attempt++) {
                back = docker(["exec", browser.container, "pgrep", "-x", "x11vnc"], { allowFail: true }).status === 0;
                if (!back) await deps.sleep(500);
              }
              if (!back) throw new Error(`x11vnc did not restart in ${browser.container}`);
            }
          }
          if (daemonToken) {
            if (await deps.brokerProbe(token) !== 200) throw new Error("the Runtime broker does not accept the new daemon token");
            systemctl(["restart", DAEMON_SERVICE]);
            if (systemctl(["is-active", DAEMON_SERVICE], { allowFail: true }).status !== 0) throw new Error("the Happy daemon is not active after the restart");
          }
          writeState(record(readState(), { action: "rotate-keys", result: done, quiesce: quiesced }));
          deps.log(`rotated ${done}`);
        } catch (error) {
          iptables(["-F", "ABP-FENCE"], { allowFail: true });
          writeState(record(readState(), { action: "rotate-keys", result: "failed", keys: done, error: error instanceof Error ? error.message : "failed" }));
          throw error;
        }
      });
    },

    setPrincipal(profileId, principalId) {
      const options = install();
      if (!options.profiles.some((profile) => profile.profileId === profileId)) throw new Error(`unknown profile ${profileId}`);
      return locked(async () => {
        await quiesce("set-principal");
        const merged = mergeInstallOptions(options, { profiles: options.profiles.map((profile) => (profile.profileId === profileId ? { profileId, principalId } : profile)) });
        deps.writeFileAtomic(PATHS.installConfig, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, owner: "root", group: "root" });
        writeRuntimeConfig(merged);
        await restartQuiescedRuntime();
      });
    },

    async status() {
      const plan = layout();
      const state = readState();
      const checks = [];
      const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
      check("service", systemctl(["is-active", SERVICE], { allowFail: true }).stdout === "active");
      check("browser egress firewall", firewall(["check-egress"], { allowFail: true }).status === 0);
      const containers = [[plan.runtime.container, state.current?.runtime], ...plan.browsers.map((browser) => [browser.container, state.current?.browser])];
      for (const [name, image] of containers) {
        const [running, label] = docker(["inspect", "-f", `{{.State.Running}} ${IMAGE_LABEL}`, name], { allowFail: true }).stdout.split(" ");
        const pinned = Boolean(image) && label === image;
        check(`container ${name}`, running === "true" && pinned, `running=${running || "missing"} image=${pinned ? "pinned" : label || "none"}`);
      }
      const published = docker(["ps", "--filter", `label=${STACK_LABEL}`, "--format", "{{.Names}}\t{{.Ports}}"], { allowFail: true }).stdout
        .split("\n").filter(Boolean).flatMap((line) => {
          const [name, ports = ""] = line.split("\t");
          return ports.split(",").map((port) => port.trim()).filter((port) => port.includes("->")).map((port) => `${name} ${port}`);
        });
      const expected = `${plan.runtime.container} 127.0.0.1:${plan.runtimePort}->${plan.runtimePort}/tcp`;
      check("published ports", published.length === 1 && published[0] === expected, published.join("; ") || "none");
      const ready = await deps.ready(plan.runtimePort);
      check("runtime ready", ready.status === 200, JSON.stringify(ready.body ?? {}));
      // A sandboxed renderer/zygote lives in a nested PID namespace (NSpid has two ids); no process may carry --no-sandbox.
      const probe = "s=0; for p in $(pgrep -f -- '--type=([r]enderer|[z]ygote)'); do set -- $(grep '^NSpid:' /proc/$p/status 2>/dev/null); [ $# -ge 3 ] && s=$((s+1)); done; echo \"sandboxed $s\"; echo \"nosandbox $(pgrep -fc -- '--no-[s]andbox' || true)\"";
      for (const browser of plan.browsers) {
        const out = docker(["exec", browser.container, "sh", "-c", probe], { allowFail: true }).stdout;
        const value = (key) => Number(out.match(new RegExp(`^${key} (\\d+)$`, "m"))?.[1] ?? NaN);
        check(`chromium sandbox ${browser.container}`, value("sandboxed") > 0 && value("nosandbox") === 0, out.replace(/\n/g, " "));
      }
      return { ok: checks.every((entry) => entry.ok), images: state.current, previous: state.previous, checks };
    },

    /** Builds both images in a minimal context (no node_modules) and optionally saves them with a digest manifest. */
    build({ source, out, tag = `local-${deps.now()}` }) {
      const packageDir = resolve(source);
      const staging = deps.tempDir();
      try {
        deps.run(process.execPath, [join(packageDir, "scripts/browser-poc/build-runtime.mjs"), join(staging, "runtime.mjs")]);
        const poc = join(packageDir, "scripts/browser-poc/images");
        const own = join(packageDir, "scripts/agent-browser/images");
        for (const [from, name] of [[join(poc, "runtime-entrypoint.sh"), "runtime-entrypoint.sh"], [join(poc, "cdp-proxy.py"), "cdp-proxy.py"], [join(poc, "instance-server.py"), "instance-server.py"],
          [join(own, "runtime.Dockerfile"), "runtime.Dockerfile"], [join(own, "browser.Dockerfile"), "browser.Dockerfile"], [join(own, "browser-entrypoint.sh"), "browser-entrypoint.sh"]]) {
          deps.copyFile(from, join(staging, name));
        }
        const ids = {};
        for (const role of ["runtime", "browser"]) {
          docker(["build", "--pull=false", "-f", join(staging, `${role}.Dockerfile`), "-t", `abp-${role}:${tag}`, staging]);
          ids[role] = docker(["image", "inspect", "--format", "{{.Id}}", `abp-${role}:${tag}`]).stdout;
        }
        assertImages(ids);
        if (out) {
          deps.mkdir(out);
          docker(["save", "-o", join(out, "images.tar"), `abp-runtime:${tag}`, `abp-browser:${tag}`]);
          const manifest = { schemaVersion: 1, tag, builtAtMs: deps.now(), runtime: { id: ids.runtime, tag: `abp-runtime:${tag}` }, browser: { id: ids.browser, tag: `abp-browser:${tag}` } };
          deps.writeFileAtomic(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, owner: "root", group: "root" });
        }
        return ids;
      } finally {
        deps.remove(staging);
      }
    },
  };
  return stack;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

/** abp-stack.service: start, then supervise until SIGTERM, then fence, drain and stop (Runtime first), verified. */
async function runForeground(deps, stack) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    deps.log("stopping: fence, drain, Runtime, browsers");
    stack.stop().then(() => process.exit(0), (error) => {
      deps.log(`stop failed: ${error instanceof Error ? error.message : "failed"}`);
      process.exit(1);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await stack.start();
  const backoff = new Map();
  for (;;) {
    await deps.sleep(2_000);
    if (!stopping) stack.superviseOnce(backoff);
  }
}

export async function main(argv, deps = systemDeps()) {
  if (process.getuid?.() !== 0) throw new Error("run as root");
  const [command, ...args] = argv;
  const stack = createStack(deps);
  const timeout = option(args, "--ready-timeout") ? Number(option(args, "--ready-timeout")) * 1_000 : undefined;
  switch (command) {
    case "run": return runForeground(deps, stack);
    case "up": {
      await stack.locked(async () => deps.run("systemctl", ["start", SERVICE]));
      const ready = await waitForReady(deps, timeout);
      console.log(ready ? "ready" : "started, not ready yet (abp-stack status)");
      process.exitCode = ready ? 0 : 1;
      return;
    }
    case "down": await stack.locked(async () => deps.run("systemctl", ["stop", SERVICE])); return;
    case "emergency-stop": await stack.emergencyStop(); return;
    case "status": {
      const report = await stack.status();
      if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
      else for (const check of report.checks) console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? `  ${check.detail}` : ""}`);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case "load": {
      const ids = stack.load(args[0]);
      if (args.includes("--set-initial")) await stack.locked(async () => stack.setInitialImages(ids));
      console.log(JSON.stringify(ids));
      return;
    }
    case "build": {
      const ids = stack.build({ source: option(args, "--source") ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."), out: option(args, "--out"), tag: option(args, "--tag") });
      if (args.includes("--set-initial")) stack.setInitialImages(ids);
      console.log(JSON.stringify(ids));
      return;
    }
    case "upgrade": {
      const images = option(args, "--images");
      const ids = images ? undefined : { runtime: option(args, "--runtime-image"), browser: option(args, "--browser-image") };
      console.log(JSON.stringify(await stack.upgrade({ images, ids, readyTimeoutMs: timeout })));
      return;
    }
    case "rollback": console.log(JSON.stringify(await stack.rollback({ readyTimeoutMs: timeout }))); return;
    case "rotate-keys": {
      const some = args.includes("--daemon-token") || args.includes("--vnc-password");
      await stack.rotateKeys({ daemonToken: !some || args.includes("--daemon-token"), vncPassword: !some || args.includes("--vnc-password") });
      return;
    }
    case "set-principal":
      if (!args[0] || !args[1]) throw new Error("usage: abp-stack set-principal <profileId> <principalId>");
      await stack.setPrincipal(args[0], args[1]);
      return;
    default:
      throw new Error("usage: abp-stack up|down|emergency-stop|status|upgrade|rollback|rotate-keys|set-principal|load|build|run");
  }
}

async function waitForReady(deps, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const { runtimePort } = JSON.parse(deps.readFile(PATHS.installConfig));
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if ((await deps.ready(runtimePort)).status === 200) return true;
    await deps.sleep(1_000);
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`abp-stack: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}

