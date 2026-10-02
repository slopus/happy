#!/usr/bin/env node
// abp-stack — operate the Agent Browser stack on execution machine H (spec D11).
// Installed by abp-install as /usr/local/sbin/abp-stack (root only).
//
//   abp-stack up | down | status [--json]
//   abp-stack emergency-stop                                      (no lock, no drain; incidents only)
//   abp-stack upgrade (--images <dir> | --runtime-image <sha256:…> --browser-image <sha256:…>) [--ready-timeout <s>]
//   abp-stack rollback [--ready-timeout <s>]
//   abp-stack rotate-keys [--daemon-token] [--vnc-password]      (both when neither is given)
//   abp-stack set-principal <profileId> <principalId>              (switches to that owner's browser volume)
//   abp-stack set-principal --resume | --abort
//   abp-stack add-profile <studio userId> | remove-profile <studio userId> [--block]   (shared machine)
//   abp-stack list-profiles [--json] | recover-profiles                                 (shared machine)
//   abp-stack load <dir> [--set-initial]                          (docker load + digest check)
//   abp-stack build --source <happy-cli dir> [--out <dir>] [--tag <tag>] [--set-initial]
//   abp-stack run                                                 (abp-stack.service only)
//
// Containers, networks and volumes carry the label ai.saycode.abp=stack. Images
// are referenced only by content digest (sha256:…); /var/lib/abp/stack-state.json
// records the current and previous digests. Volumes (abp-state, abp-profile-*)
// are retained unless explicitly removed with delete-profile-volume or abp-uninstall --purge.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fchownSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTAINER_MEMORY_GIB, MAX_SHARED_PROFILES, PATHS, STACK_LABEL, browserCreateArgs, fenceRule, legacyProfileVolumeName, profileVolumeName, profileVolumeLabels, mergeInstallOptions, networkCreateArgs, runtimeConfig, runtimeCreateArgs, sharedProfileId, stackLayout } from "./lib/abpPlan.mjs";

import { PROFILE_COPY } from "./lib/profileCopy.mjs";

const refusal = (message) => Object.assign(new Error(message), { exitCode: 78 });

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
/** Lowest image and package contract an install runs on: shared machines need tenancyMode in runtime.json (3). */
const requiredContract = (install) => (install?.tenancyMode === "shared" ? 3 : 2);
const IMAGE_LABEL = '{{index .Config.Labels "ai.saycode.abp.image"}}';
const RESTART_BACKOFF_MS = { first: 2_000, max: 60_000, resetAfterRunningMs: 60_000 };
const DEFAULT_READY_TIMEOUT_MS = 180_000;
const DEFAULT_DRAIN_MS = 60_000;
/** Browser stop: the entrypoint gives Chromium 20 s to exit and write its profile (cookies). */
const BROWSER_STOP_S = 30;
const EGRESS_CHECK_INTERVAL_MS = 10_000;
const FIREWALL = `${PATHS.libexec}/abp-firewall`;
/** Set by emergency-stop so the service stop skips the drain; removed by the next start. */
const EMERGENCY_FLAG = "/run/abp-stack-emergency";
/**
 * Set (with its time) while an upgrade or rollback replaces single containers of the running stack, so
 * the supervisor does not restart the container being replaced. Older than MAINTENANCE_MAX_MS = left
 * behind by a crashed operation, and ignored.
 */
const START_REQUEST = "/run/abp-stack-start-request";
const MAINTENANCE_FLAG = "/run/abp-stack-maintenance";
const MAINTENANCE_MAX_MS = 15 * 60_000;
/** A first-use profile request the machine cannot hold (or that failed) is refused this long. */
const PROFILE_REFUSAL_MS = 10 * 60_000;
const PROFILE_BUSY_RETRY_MS = 2 * 60_000;
/** Busy postponements of one request before it is refused as busy. */
const PROFILE_BUSY_RETRIES = 3;
const PROFILE_POLL_MS = 3_000;
const NETWORK_FORMAT = '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}} {{index .Options "com.docker.network.bridge.name"}}';
const SERVICE = "abp-stack.service";
const DAEMON_SERVICE = "abp-happy-daemon.service";
const SECRET_FILES = {
  runtimeVnc: { path: `${PATHS.runtimeSecrets}/vnc-password`, mode: 0o440, owner: "abp-runtime", group: "root" },
  browserVnc: { path: `${PATHS.browserSecrets}/vnc-password`, mode: 0o400, owner: "abp-browser", group: "abp-browser" },
  daemonToken: { path: PATHS.daemonToken, mode: 0o400, owner: "agent", group: "agent" },
};

/** Real host: docker/systemctl through spawnSync, atomic root-owned writes, loopback readiness. */
function unixJson(socketPath, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: body === undefined ? "GET" : "POST", headers: { ...headers, "content-type": "application/json" }, timeout: 3_000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => { try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : undefined }); } catch { resolve({ status: res.statusCode }); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
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
    adminReady: () => unixJson(PATHS.adminSocket, "/admin/ready", {}).then((r) => r.status === 200 ? r.body?.result : undefined, () => undefined),
    openAdmission: (assignments) => unixJson(PATHS.adminSocket, "/admin/open-admission", {}, { assignments }).then((r) => r.status === 200 && r.body?.result?.admission === "open", () => false),
    /** /proc/meminfo in bytes: add-profile checks the budget and what is available now. */
    memInfo: () => {
      const info = readFileSync("/proc/meminfo", "utf8");
      const kib = (key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(info)?.[1] ?? NaN) * 1024;
      return { totalBytes: kib("MemTotal"), availableBytes: kib("MemAvailable") };
    },
    adminProfileRequests: () => unixJson(PATHS.adminSocket, "/admin/profile-requests", {}).then((reply) => (reply.status === 200 ? reply.body?.result?.requests : undefined), () => undefined),
    refuseProfileRequest: (principalId, reason, retryAfterMs) => unixJson(PATHS.adminSocket, "/admin/profile-requests/refuse", {}, { principalId, reason, retryAfterMs }).then((reply) => reply.status === 200, () => false),
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
  /** First-use additions that failed, per user, for the service's lifetime (their refusals grow). */
  const failedAdditions = new Map();
  /** Consecutive busy postponements per user (the drain timed out). */
  const busyPostponements = new Map();
  const docker = (args, opts) => deps.run("docker", args, opts);
  const systemctl = (args, opts) => deps.run("systemctl", args, opts);
  const firewall = (args, opts) => deps.run(FIREWALL, args, opts);
  const iptables = (args, opts) => deps.run("iptables", ["-w", "-t", "filter", ...args], opts);
  const readJson = (path) => {
    const contents = deps.readFile(path);
    try { return JSON.parse(contents); }
    catch { throw refusal(`${basename(path)} is not valid JSON; operator recovery required`); }
  };
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
      if (!IMAGE_ID.test(ids?.[role] ?? "")) throw refusal(`${role} image must be a content digest (sha256:<64 hex>)`);
      const found = docker(["image", "inspect", "--format", "{{.Id}}", ids[role]], { allowFail: true });
      if (found.status !== 0) throw new Error(`${role} image ${ids[role]} is not loaded`);
      if (found.stdout !== ids[role]) throw refusal(`${role} image digest mismatch`);
      const contract = docker(["image", "inspect", "--format", '{{index .Config.Labels "ai.saycode.abp.contract"}}', ids[role]]);
      const required = requiredContract(install());
      if (!/^\d+$/.test(contract.stdout) || Number(contract.stdout) < required) throw refusal(`${role} image requires assignment contract ${required}; downgrade refused`);
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

  /** The detached marks after a reassignment: the previous volume detached now, the new one attached. */
  function markVolumes(marks, profileId, fromVolume, toVolume) {
    const next = (marks ?? []).map((mark) => ({ ...mark }));
    const entry = (volume) => next.find((mark) => mark.volume === volume) ?? next[next.push({ profileId, volume }) - 1];
    entry(fromVolume).detachedAtMs = deps.now();
    delete entry(toVolume).detachedAtMs;
    return next;
  }

  const identity = (options) => Object.fromEntries(options.profiles.map(({ profileId, principalId, assignmentId }) => [profileId, { principalId, assignmentId }]));
  const assignments = (options) => Object.fromEntries(options.profiles.map(({ profileId, assignmentId }) => [profileId, assignmentId]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const writeInstall = (options) => deps.writeFileAtomic(PATHS.installConfig, `${JSON.stringify(options, null, 2)}\n`, { mode: 0o600, owner: "root", group: "root" });
  function assertPackageContract(options) {
    const marker = join(options.happyPrefix ?? PATHS.happyPrefix, "lib/node_modules/@buzzni/happy-cli/scripts/agent-browser/contract.json");
    let contract;
    try { contract = readJson(marker); } catch {}
    const required = requiredContract(options);
    if (!(contract?.contractVersion >= required)) throw refusal(`installed Happy package requires assignment/lineage contract ${required}; install the current --happy-tarball`);
  }
  /**
   * checkPackage false (the periodic supervisor): abp-install swaps the package with two renames, and a tick
   * between them must not stop a running stack; start, up, set-principal and upgrade still check it.
   */
  function assertStable(allowStartRecovery = false, { checkPackage = true, allowFailedProfileOp = false } = {}) {
    if (checkPackage) assertPackageContract(install());
    const settled = allowFailedProfileOp && readState().profileOp?.phase === "failed";
    const state = readState();
    if (!allowStartRecovery && deps.exists(START_REQUEST)) throw refusal("unfinished service startup; use abp-stack up or assignment/migration recovery");
    if (state.migrationHold) throw refusal("incomplete legacy migration; preserve both volumes and inspect before recovery");
    if (state.transition) throw refusal("unfinished assignment transition; use set-principal --resume or --abort");
    if (state.profileOp && !settled) throw refusal(`unfinished ${state.profileOp.op}-profile; restart the stack (abp-stack up --restart) or run abp-stack recover-profiles`);
    if (!settled && state.applied && !same(state.applied, identity(install()))) throw refusal("install identity differs from applied assignment; direct edits are refused");
  }
  function validConfig(options) {
    assertPackageContract(options);
    if (options.schemaVersion !== 2 || options.profiles.some((p) => !/^[0-9a-f]{32}$/.test(p.assignmentId ?? ""))) throw refusal("assignment schema 2 required; run the current installer");
  }
  function alignRuntimeConfig(options) { writeRuntimeConfig({ ...options, admissionHold: true }); }

  /** Unknown-owner legacy volumes are quarantined, never removed or adopted on start. */
  function checkLegacyVolumes(browsers, persist = true) {
    const listed = docker(["volume", "ls", "-q"]).stdout.split("\n").filter(Boolean);
    for (const browser of browsers) {
      const legacy = legacyProfileVolumeName(browser.profileId);
      if (!listed.includes(legacy)) continue;
      const state = readState();
      if (state.migrations?.some((m) => m.source === legacy && m.phase === "verified")) continue;
      const legacyVolumes = [...(state.legacyVolumes ?? [])];
      if (!legacyVolumes.some((m) => m.volume === legacy)) legacyVolumes.push({ volume: legacy, firstSeenAtMs: deps.now(), status: "quarantined" });
      if (persist && legacyVolumes.length !== (state.legacyVolumes ?? []).length) writeState({ ...state, legacyVolumes });
      throw refusal(`legacy profile volume ${legacy} is quarantined; explicit owner-verified migration required`);
    }
  }
  function volumeInfo(volume) {
    const result = docker(["volume", "inspect", volume], { allowFail: true });
    if (result.status !== 0) {
      if (/no such volume/i.test(result.stderr)) return undefined;
      throw new Error(`cannot inspect volume ${volume}`);
    }
    const entries = JSON.parse(result.stdout);
    if (!Array.isArray(entries) || entries.length !== 1 || entries[0].Name !== volume) throw new Error(`invalid volume inspection for ${volume}`);
    return entries[0];
  }
  function validateVolume(volume, labels) {
    const info = volumeInfo(volume);
    if (!info || labels.some((label) => { const i = label.indexOf("="); return info.Labels?.[label.slice(0, i)] !== label.slice(i + 1); })) throw refusal(`profile volume labels mismatch: ${volume}`);
  }
  function ensureProfileVolume(browser) {
    if (readState().migrations?.some((m) => m.target === browser.volume && m.phase !== "verified")) throw refusal(`incomplete migration: ${browser.volume}`);
    if (!volumeInfo(browser.volume)) docker(["volume", "create", ...browser.volumeLabels.map((label) => `--label=${label}`), browser.volume]);
    validateVolume(browser.volume, browser.volumeLabels);
  }
  function detached(volume) {
    if (docker(["ps", "-aq", "--filter", `volume=${volume}`]).stdout) throw new Error(`volume ${volume} is attached to a container`);
  }
  function hasExpectedProfileMount(browser) {
    const mounts = JSON.parse(docker(["inspect", "-f", "{{json .Mounts}}", browser.container]).stdout);
    const profiles = mounts.filter((m) => m.Destination === "/home/browser/profile");
    return profiles.length === 1 && profiles[0].Type === "volume" && profiles[0].Name === browser.volume && profiles[0].RW === true;
  }
  /**
   * The Runtime serves these assignments, cleaned up. A dedicated machine needs every browser; a shared one only
   * the browsers of `requireBrowsers` (the profile a change is about), so one user's broken browser holds nobody else.
   */
  async function verifyAssignment(options, { requireBrowsers = [] } = {}) {
    const shared = options.tenancyMode === "shared";
    const deadline = deps.now() + DEFAULT_READY_TIMEOUT_MS;
    for (;;) {
      const ready = await deps.adminReady();
      if (ready && ready.assignment?.state === "ready" && same(ready.assignment.applied, assignments(options)) && same(identity({ profiles: ready.profiles ?? [] }), identity(options))
        && [...shared ? [] : ["browsers"], "writerLock", "disk", "revocations", "principalState"].every((key) => ready.checks?.[key] === true)
        && requireBrowsers.every((profileId) => ready.profileBrowsers?.[profileId] === true)) break;
      if (deps.now() >= deadline) throw new Error("admin readiness or applied assignment mismatch");
      await deps.sleep(1000);
    }
    const plan = stackLayout(options);
    const current = readState().current;
    const browsers = shared ? plan.browsers.filter((browser) => requireBrowsers.includes(browser.profileId)) : plan.browsers;
    for (const [name, expected] of [[plan.runtime.container, current.runtime], ...browsers.map((b) => [b.container, current.browser])]) {
      const actual = docker(["inspect", "-f", `{{.State.Running}} ${IMAGE_LABEL}`, name]).stdout;
      if (actual !== `true ${expected}`) throw new Error(`unexpected container image: ${name}`);
    }
    // Every browser is on its owner's volume, connected or not.
    for (const browser of plan.browsers) {
      validateVolume(browser.volume, browser.volumeLabels);
      if (!hasExpectedProfileMount(browser)) throw new Error(`wrong profile mount: ${browser.container}`);
    }
  }
  async function releaseAdmission(options) {
    if (!await deps.openAdmission(assignments(options))) throw new Error("Runtime refused to open assignment admission");
    // Persist open only after the live process has verified the generation. On reboot start holds it again.
    writeRuntimeConfig({ ...options, admissionHold: false });
    unfence();
  }
  function clearStartRequest() { if (deps.exists(START_REQUEST)) deps.remove(START_REQUEST); }
  async function startServiceHeld(options) {
    validConfig(options);
    assertImages(readState().current);
    checkLegacyVolumes(stackLayout(options).browsers);
    writeRuntimeConfig({ ...options, admissionHold: true });
    deps.writeFileAtomic(START_REQUEST, JSON.stringify({ identity: identity(options), images: readState().current }), { mode: 0o600, owner: "root", group: "root" });
    systemctl(["start", SERVICE]);
    await verifyAssignment(options);
  }
  /** A rejection must not leave Docker containers alive outside systemd's cgroup. */
  function stopRejectedStack() {
    const ports = new Set([38700]);
    for (const path of [PATHS.installConfig, PATHS.runtimeConfig]) {
      try { const port = readJson(path).runtimePort; if (Number.isInteger(port) && port >= 1024 && port <= 65535) ports.add(port); } catch {}
    }
    for (const port of ports) {
      if (iptables(["-C", "ABP-FENCE", ...fenceRule(port)], { allowFail: true }).status !== 0
        && iptables(["-A", "ABP-FENCE", ...fenceRule(port)], { allowFail: true }).status !== 0) deps.log(`cannot fence Runtime port ${port}; stopping containers`);
    }
    const names = new Set(["abp-runtime", ...docker(["ps", "-aq", "--filter", `label=${STACK_LABEL}`]).stdout.split("\n").filter(Boolean)]);
    try { for (const browser of layout().browsers) names.add(browser.container); } catch {}
    for (const name of names) docker(["stop", "-t", name === "abp-runtime" ? "30" : String(BROWSER_STOP_S), name], { allowFail: true });
    for (const name of names) ensureStopped(name);
  }

  async function applyOwners(options, marks) {
    systemctl(["stop", SERVICE]);
    verifyStopped();
    writeInstall(options);
    writeRuntimeConfig({ ...options, admissionHold: true });
    writeState({ ...readState(), profileVolumes: marks, transition: { ...readState().transition, target: options, phase: "committed" } });
    await startServiceHeld(options);
    writeState({ ...readState(), applied: identity(options), transition: { ...readState().transition, phase: "verified" } });
    await releaseAdmission(options);
    // If we die before this write, start still holds admission and requires explicit recovery.
    const { transition, ...state } = readState();
    writeState(record(state, { action: "set-principal", result: "ready", profileId: transition.profileId }));
    clearStartRequest();
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
      throw Object.assign(new Error(`${action} aborted: ${reason}; nothing was stopped or changed (abp-stack emergency-stop stops regardless)`), { nothingChanged: true });
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
    for (const name of new Set([plan.runtime.container, ...plan.browsers.map((browser) => browser.container), ...docker(["ps", "-aq", "--filter", `label=${STACK_LABEL}`]).stdout.split("\n").filter(Boolean)])) ensureStopped(name);
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
  async function restartQuiescedRuntime() {
    const options = install();
    writeRuntimeConfig({ ...options, admissionHold: true });
    const { runtime } = layout();
    if (docker(["restart", "-t", "30", runtime.container], { allowFail: true }).status !== 0) throw new Error("docker restart failed for the Runtime");
    await verifyAssignment(options);
    await releaseAdmission(options);
  }

  /** The network exists with its subnet, gateway and bridge name; one that differs is recreated. */
  function ensureNetwork(network) {
    const found = docker(["network", "inspect", "-f", NETWORK_FORMAT, network.network], { allowFail: true });
    if (found.status === 0 && found.stdout === `${network.subnet} ${network.gateway} ${network.bridge}`) return;
    if (found.status === 0) docker(["network", "rm", network.network]);
    docker(networkCreateArgs(network));
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
    // A browser still on another volume (from before per-owner volumes) is replaced too.
    const onOtherVolume = (browser) => !hasExpectedProfileMount(browser);
    const browsers = plan.browsers.filter((browser) => differs(browser.container, target.browser) || onOtherVolume(browser));
    const runtime = differs(plan.runtime.container, target.runtime);
    const replaced = [...browsers.length ? ["browser"] : [], ...runtime ? ["runtime"] : []];
    const detail = { replaced, ...quiesced ? { quiesce: quiesced } : {} };
    deps.writeFileAtomic(MAINTENANCE_FLAG, String(deps.now()), { mode: 0o600, owner: "root", group: "root" });
    try {
      if (browsers.length && !egressInPlace()) throw new Error("browser egress firewall is not in place");
      if (runtime) stopAndRemove(plan.runtime.container, 30);
      for (const browser of browsers) {
        stopAndRemove(browser.container, BROWSER_STOP_S);
        checkLegacyVolumes([browser]);
        ensureProfileVolume(browser);
        createAndStartBrowser(plan, browser, target.browser);
      }
      if (runtime) {
        writeRuntimeConfig({ ...install(), admissionHold: true });
        createAndStartRuntime(plan, target.runtime);
      }
      writeState({ ...readState(), current: target, previous });
      await verifyAssignment(install());
      await releaseAdmission(install());
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
      const options = install();
      await startServiceHeld(options);
      writeState({ ...readState(), applied: identity(options) });
      await releaseAdmission(options);
      clearStartRequest();
      const ready = await waitReady(target.runtime, readyTimeoutMs);
      writeState(record(readState(), { action, from: before.current, to: target, result: ready.ok ? "ready" : "not-ready", ready: ready.body, ...quiesced ? { quiesce: quiesced } : {} }));
      return { ok: ready.ok, ready: ready.body, before };
    } catch (error) {
      try {
        writeState(record(readState(), { action, from: before.current, to: target, result: "failed", error: error instanceof Error ? error.message : "failed", ...quiesced ? { quiesce: quiesced } : {} }));
      } catch { deps.log(`${action}: failure history could not be written; stopping the stack`); }
      // Do not leave an active delegated service/request for rollback to mistake for an ordinary
      // running stack. Only remove the request after every container is verified stopped.
      systemctl(["stop", SERVICE]);
      verifyStopped();
      clearStartRequest();
      return { ok: false, before };
    }
  }

  function requireShared(options) {
    if (options.tenancyMode !== "shared") throw refusal("profiles are added and removed only on a shared machine (abp-install --tenancy shared)");
  }
  /** K11: fewer than 8 profiles, a static budget of container limits, and memory available right now. */
  function assertCapacity(options) {
    const full = (message, reason) => Object.assign(refusal(message), { capacityReason: reason });
    if (options.profiles.length >= MAX_SHARED_PROFILES) throw full(`a shared machine runs at most ${MAX_SHARED_PROFILES} browser profiles`, "capacity");
    const GiB = 2 ** 30;
    const { totalBytes, availableBytes } = deps.memInfo();
    const budget = (CONTAINER_MEMORY_GIB.runtime + CONTAINER_MEMORY_GIB.browser * (options.profiles.length + 1)) * GiB;
    if (totalBytes - (options.memoryReserveMiB ?? 4096) * 2 ** 20 < budget) throw full(`not enough memory for another browser profile (${options.profiles.length} running; memoryReserveMiB ${options.memoryReserveMiB ?? 4096})`, "memory");
    if (availableBytes < (CONTAINER_MEMORY_GIB.browser + 1) * GiB) throw full("not enough memory available right now for another browser profile", "memory");
  }
  /** Recreates the Runtime for these profiles (browsers keep running), verifies it and opens admission. */
  async function recreateRuntime(options, requireBrowsers = []) {
    const plan = stackLayout(options);
    stopAndRemove(plan.runtime.container, 30);
    writeRuntimeConfig({ ...options, admissionHold: true });
    ensureNetwork(plan.runtimeNetwork);
    createAndStartRuntime(plan, readState().current.runtime);
    await verifyAssignment(options, { requireBrowsers });
    writeState({ ...readState(), applied: identity(options) });
    await releaseAdmission(options);
  }
  /**
   * add-profile / remove-profile (K9): the browser's own containers and network, and a new Runtime for the
   * new set of profiles; the other browsers keep running with their pages and pending approvals. Journaled
   * (profileOp) so that start, supervision and other operations hold until it finished or recover-profiles
   * put the previous profiles back. A failure is rolled back to the previous profiles.
   */
  /**
   * Settles a profile change left behind: before its commit (or an addition whose rollback failed) the previous
   * profiles, after it the new ones. Only for a caller that then recreates every container (start, up --restart).
   */
  function settleProfileChange() {
    const { profileOp, ...rest } = readState();
    if (!profileOp) return;
    const adopted = profileOp.phase === "committed" || (profileOp.phase === "failed" && profileOp.committed && profileOp.op === "remove") ? "next" : "before";
    if (adopted === "before") writeInstall(profileOp.before);
    writeState(record({ ...rest, applied: identity(install()) }, { action: "settle-profile-change", op: profileOp.op, profileId: profileOp.profileId, phase: profileOp.phase, adopted }));
  }

  /** Containers change only under the running stack service (never after down or emergency-stop). */
  function requireRunningService() {
    if (deps.exists(EMERGENCY_FLAG)) throw refusal("the stack is emergency-stopped; bring it back with abp-stack up first");
    if (systemctl(["is-active", SERVICE], { allowFail: true }).stdout !== "active") throw refusal("the stack service is not running; start it with abp-stack up first");
  }
  /**
   * add-profile / remove-profile (K9): the browser's own containers and network, and a new Runtime for the
   * new set of profiles; the other browsers keep running with their pages and pending approvals. Journaled
   * (profileOp) so that other operations hold until it finished; a service start settles one left behind.
   * Before the commit a failure only undoes the new browser; after it an addition is rolled back (its user
   * never had a session) and a removal goes forward (that user's sessions have already ended).
   * `firstUse`: a session asked for it; a blocked user is refused.
   */
  async function changeProfile(op, principalId, { block = false, firstUse = false } = {}) {
    const options = install();
    requireShared(options);
    assertStable();
    if (typeof principalId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(principalId)) throw refusal("usage: a Studio user id");
    const profileId = sharedProfileId(principalId);
    const existing = options.profiles.find((profile) => profile.principalId === principalId);
    const tombstone = (options.profileTombstones ?? []).find((entry) => entry.principalId === principalId);
    const others = (options.profileTombstones ?? []).filter((entry) => entry.principalId !== principalId);
    let next;
    if (op === "add") {
      if (existing) return { changed: false, profileId, networkSlot: existing.networkSlot };
      if (firstUse && tombstone?.removedAtMs === Number.MAX_SAFE_INTEGER) throw Object.assign(refusal("the user was removed from this machine with --block"), { capacityReason: "blocked" });
      assertCapacity(options);
      const used = new Set(options.profiles.map((profile) => profile.networkSlot));
      const networkSlot = [...Array(MAX_SHARED_PROFILES).keys()].find((slot) => !used.has(slot));
      // The removal time stays: the user's chats from before the removal remain retired. A block becomes a removal now.
      const kept = tombstone ? [{ principalId, removedAtMs: tombstone.removedAtMs === Number.MAX_SAFE_INTEGER ? deps.now() : tombstone.removedAtMs }] : [];
      next = { ...options, profiles: [...options.profiles, { profileId, principalId, assignmentId: randomBytes(16).toString("hex"), networkSlot }], profileTombstones: [...others, ...kept] };
    } else {
      next = { ...options, profiles: options.profiles.filter((profile) => profile.principalId !== principalId),
        // A block stays until add-profile lifts it, also through a later plain remove-profile.
        profileTombstones: [...others, { principalId, removedAtMs: block || tombstone?.removedAtMs === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : deps.now() }] };
      if (!existing) {
        // Nothing runs for the user: the tombstone reaches the broker with the next Runtime start.
        writeInstall(mergeInstallOptions(next, {}));
        return { changed: false, profileId };
      }
    }
    next = mergeInstallOptions(next, {});
    requireRunningService();
    const action = `${op}-profile`;
    const quiesced = await quiesce(action);
    const browser = stackLayout(op === "add" ? next : options).browsers.find((entry) => entry.profileId === profileId);
    let committed = false;
    const journal = (phase) => writeState({ ...readState(), profileOp: { op, principalId, profileId, phase, committed, before: options } });
    const finish = (result, detail = {}) => { const { profileOp, ...state } = readState(); writeState(record(state, { action, result, profileId, ...detail })); };
    try {
      journal("started");
      deps.writeFileAtomic(MAINTENANCE_FLAG, String(deps.now()), { mode: 0o600, owner: "root", group: "root" });
      if (op === "add") {
        ensureNetwork(browser);
        checkLegacyVolumes([browser]);
        ensureProfileVolume(browser);
        createAndStartBrowser(stackLayout(next), browser, readState().current.browser);
      }
      writeInstall(next);
      journal("committed");
      committed = true;
      await recreateRuntime(next, op === "add" ? [profileId] : []);
      if (op === "remove") {
        // Best effort: a browser left behind is outside the plan and goes with the next start.
        try { stopAndRemove(browser.container, BROWSER_STOP_S); } catch (error) { deps.log(`remove-profile: ${browser.container} not removed: ${error instanceof Error ? error.message : "failed"}`); }
        docker(["network", "rm", browser.network], { allowFail: true });
      }
      finish("ready", { quiesce: quiesced });
      return { changed: true, profileId, ...op === "add" ? { networkSlot: next.profiles.find((profile) => profile.profileId === profileId).networkSlot } : {} };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "failed";
      if (committed && op === "remove") {
        journal("failed");
        writeState(record(readState(), { action, result: "failed", profileId, error: reason }));
        throw new Error(`${action} failed after its commit (${reason}); the user is removed. Restart the stack (abp-stack up --restart) to settle it`);
      }
      try {
        writeInstall(options);
        if (op === "add") {
          try { stopAndRemove(browser.container, BROWSER_STOP_S); } catch {}
          docker(["network", "rm", browser.network], { allowFail: true });
        }
        // Before the commit the Runtime still serves the previous profiles: only the fence goes.
        if (committed) await recreateRuntime(options);
        else unfence();
        finish("rolled-back", { error: reason });
      } catch (rollbackError) {
        journal("failed");
        writeState(record(readState(), { action, result: "failed", profileId, error: reason }));
        throw new Error(`${action} failed (${reason}) and could not be rolled back (${rollbackError instanceof Error ? rollbackError.message : "failed"}); restart the stack (abp-stack up --restart) or run abp-stack recover-profiles`);
      }
      throw new Error(`${action} failed (${reason}); the previous profiles were restored`);
    } finally {
      if (deps.exists(MAINTENANCE_FLAG)) deps.remove(MAINTENANCE_FLAG);
    }
  }


  const stack = {
    locked,
    addProfile: (principalId) => locked(() => changeProfile("add", principalId)),
    removeProfile: (principalId, options) => locked(() => changeProfile("remove", principalId, options)),
    /**
     * The abp-stack service, every few seconds on a shared machine: adds a profile a session asked for on first use
     * (the broker verified the user's attestation). One at a time, and only when no other operation holds the lock;
     * a request that cannot be served (capacity, memory, blocked, or a failed addition) is refused with the reason
     * for 10 minutes.
     */
    async provisionRequestedProfiles(backoff) {
      if (install().tenancyMode !== "shared") return {};
      const requests = (await deps.adminProfileRequests()) ?? [];
      const now = deps.now();
      // A newer chat of a refused user asks again: the broker gets the same refusal for what is left of it.
      for (const entry of requests) {
        const held = backoff.get(entry.principalId);
        if (held?.reason && held.until > now) await deps.refuseProfileRequest(entry.principalId, held.reason, held.until - now);
      }
      const request = requests.find((entry) => (backoff.get(entry.principalId)?.until ?? 0) <= now);
      if (!request) return {};
      let release;
      try { release = await deps.opLock(); } catch { return { busy: true }; }
      try {
        // A journal while the lock is free: its owner died. The service restarts and its start settles it.
        if (readState().profileOp) return { restartToSettle: true };
        await changeProfile("add", request.principalId, { firstUse: true });
        backoff.delete(request.principalId);
        busyPostponements.delete(request.principalId);
        deps.log(`profile added on first use: ${sharedProfileId(request.principalId)}`);
        return { added: [request.principalId] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        // Busy (the drain timed out, nothing changed): tried again shortly, then refused as busy, so the fence of a
        // retry does not interrupt everyone every 2 minutes for as long as the machine stays busy.
        let reason = error?.capacityReason ?? "failed";
        if (error?.nothingChanged) {
          const postponed = (busyPostponements.get(request.principalId) ?? 0) + 1;
          if (postponed <= PROFILE_BUSY_RETRIES) {
            busyPostponements.set(request.principalId, postponed);
            backoff.set(request.principalId, { until: deps.now() + PROFILE_BUSY_RETRY_MS });
            deps.log(`profile request postponed: ${message}`);
            return { busy: true };
          }
          busyPostponements.delete(request.principalId);
          reason = "busy";
        }
        // A request that cannot be served is refused (the session is told why), for longer each time an addition
        // fails, so a persistent failure does not restart everyone's Runtime over and over.
        const failures = reason === "failed" ? (failedAdditions.get(request.principalId) ?? 0) + 1 : 1;
        if (reason === "failed") failedAdditions.set(request.principalId, failures);
        const refusalMs = Math.min(PROFILE_REFUSAL_MS * 3 ** (failures - 1), 24 * 60 * 60_000);
        backoff.set(request.principalId, { until: deps.now() + refusalMs, reason });
        await deps.refuseProfileRequest(request.principalId, reason, refusalMs);
        deps.log(`profile request refused (${reason}): ${sharedProfileId(request.principalId)}: ${message}`);
        // A change that failed for good holds the fence: the service restarts, and its start settles it.
        const restartToSettle = readState().profileOp?.phase === "failed";
        return { refused: [{ principalId: request.principalId, reason }], ...restartToSettle ? { restartToSettle: true } : {} };
      } finally { release(); }
    },

    /** Puts back the profiles from before an unfinished add/remove-profile (the whole stack restarts). */
    recoverProfiles() {
      return locked(async () => {
        const journal = readState().profileOp;
        if (!journal) throw new Error("no unfinished profile change");
        systemctl(["stop", SERVICE]);
        verifyStopped();
        writeInstall(journal.before);
        const { profileOp, ...state } = readState();
        writeState({ ...state, applied: identity(journal.before) });
        await startServiceHeld(journal.before);
        await releaseAdmission(journal.before);
        clearStartRequest();
        writeState(record(readState(), { action: "recover-profiles", result: "ready", profileId: journal.profileId, op: journal.op }));
      });
    },
    listProfiles() {
      const options = install();
      requireShared(options);
      const plan = stackLayout(options);
      return {
        profiles: options.profiles.map(({ profileId, principalId, networkSlot, assignmentId }) => {
          let running = false;
          try { running = containerState(plan.browsers.find((b) => b.profileId === profileId).container) === "running"; } catch {}
          // A re-added user keeps their removal time (their chats from before stay retired): shown here, not as removed.
          const removal = (options.profileTombstones ?? []).find((entry) => entry.principalId === principalId);
          return { profileId, principalId, networkSlot, assignmentId, volume: profileVolumeName(profileId, principalId), running, ...removal ? { removedAtMs: removal.removedAtMs } : {} };
        }),
        removed: (options.profileTombstones ?? []).filter(({ principalId }) => !options.profiles.some((profile) => profile.principalId === principalId))
          .map(({ principalId, removedAtMs }) => ({ principalId, removedAtMs, blocked: removedAtMs === Number.MAX_SAFE_INTEGER })),
        capacity: { max: MAX_SHARED_PROFILES, used: options.profiles.length },
      };
    },
    assertStable,
    /** Recreates the stack containers from the current digests (volumes kept) behind a live egress firewall, then lifts the fence. */
    async start() {
      // A root-owned request delegates container creation only; the lock-owning caller verifies and
      // opens admission. A stale request after a crash can therefore never open access on its own.
      const delegated = deps.exists(START_REQUEST);
      const release = delegated ? () => {} : await deps.opLock();
      try {
        const request = delegated ? readJson(START_REQUEST) : undefined;
        const state = readState();
        if (!state.current) throw refusal("no images installed (abp-install --images/--build-from, or abp-stack load --set-initial)");
        if (!egressInPlace()) throw new Error("browser egress firewall is not in place (abp-firewall check-egress); not starting");
        if (deps.exists(EMERGENCY_FLAG)) deps.remove(EMERGENCY_FLAG);
        assertImages(state.current);
        if (state.migrationHold) throw refusal("incomplete legacy migration; startup held");
        // A profile change left behind (crash, reboot, failed rollback) is settled here, under the lock: start
        // recreates every container anyway.
        if (!request) settleProfileChange();
        const options = install();
        validConfig(options);
        if (state.transition && !["committed", "verified"].includes(state.transition.phase)) throw refusal("assignment transition blocked; use set-principal --resume or --abort");
        if (!state.transition) assertStable(true);
        else if (!same(identity(options), identity(state.transition.target))) throw refusal("transition target mismatch");
        const plan = layout();
        const fenced = await fence();
        if (!fenced.ok) throw new Error(`startup fence failed: ${fenced.reason}`);
        if (request) {
          if (!same(request.identity, identity(options)) || !same(request.images, state.current)) throw refusal("stale delegated startup request");
          const config = readJson(PATHS.runtimeConfig);
          if (config.admissionHold !== true || !same(identity(config), identity(options))) throw refusal("delegated startup must hold the expected assignment");
        } else alignRuntimeConfig(options);
        const old = docker(["ps", "-aq", "--filter", `label=${STACK_LABEL}`]).stdout.split("\n").filter(Boolean);
        for (const name of old) stopAndRemove(name, name === plan.runtime.container ? 30 : BROWSER_STOP_S);
        checkLegacyVolumes(plan.browsers, !request);
        if (plan.runtimeNetwork) ensureNetwork(plan.runtimeNetwork);
        for (const browser of plan.browsers) ensureNetwork(browser);
        // Only the current owners' volumes: a previous owner's stays detached indefinitely.
        if (docker(["volume", "inspect", plan.runtime.volume], { allowFail: true }).status !== 0) docker(["volume", "create", `--label=${STACK_LABEL}`, plan.runtime.volume]);
        for (const browser of plan.browsers) ensureProfileVolume(browser);
        for (const browser of plan.browsers) createAndStartBrowser(plan, browser, state.current.browser);
        createAndStartRuntime(plan, state.current.runtime);
        if (!state.transition && !request) {
          await verifyAssignment(options);
          writeState({ ...readState(), applied: identity(options) });
          await releaseAdmission(options);
        }
        lastEgressCheckMs = deps.now();
        deps.log(`started runtime=${state.current.runtime} browser=${state.current.browser} profiles=${plan.browsers.length}`);
      } catch (error) {
        try { stopRejectedStack(); } catch (stopError) { throw new Error(`${error.message}; stop verification failed: ${stopError.message}`); }
        throw error;
      } finally { release(); }
    },

    up({ restart = false } = {}) {
      return locked(async () => {
        // A profile change left behind is settled by a restart (up --restart), which recreates every container.
        if (readState().profileOp) {
          if (!restart) throw refusal(`unfinished ${readState().profileOp.op}-profile; run abp-stack up --restart`);
          settleProfileChange();
        }
        assertStable(true);
        if (!restart && !deps.exists(START_REQUEST) && systemctl(["is-active", SERVICE], { allowFail: true }).stdout === "active"
          && (await deps.adminReady())?.admission === "open") {
          await verifyAssignment(install());
          return;
        }
        systemctl(["stop", SERVICE]);
        verifyStopped();
        const options = install();
        await startServiceHeld(options);
        writeState({ ...readState(), applied: identity(options) });
        await releaseAdmission(options);
        clearStartRequest();
      });
    },

    /**
     * One supervision pass: the egress firewall is re-checked every 10 s (browsers are stopped while it
     * is missing and cannot be restored), exited containers are restarted with exponential backoff
     * (exit 75 = writer lock held).
     */
    superviseOnce(backoff) {
      try {
        const plan = layout();
        if (deps.now() - lastEgressCheckMs >= EGRESS_CHECK_INTERVAL_MS) {
          if (!egressInPlace()) {
            deps.log("browser egress firewall missing and not restorable; browsers stopped until it is back");
            for (const browser of plan.browsers) docker(["stop", "-t", String(BROWSER_STOP_S), browser.container], { allowFail: true });
            return;
          }
          lastEgressCheckMs = deps.now();
        }
        // A profile change in progress holds supervision; one that failed for good does not (the others still need it).
        const profileOp = readState().profileOp;
        if (readState().transition || readState().migrationHold || (profileOp && profileOp.phase !== "failed") || deps.exists(START_REQUEST)) return;
        assertStable(false, { checkPackage: false, allowFailedProfileOp: true });
        let maintenance;
        try { maintenance = Number(deps.readFile(MAINTENANCE_FLAG)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (maintenance !== undefined && deps.now() - maintenance < MAINTENANCE_MAX_MS) return;
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
      } catch (error) {
        stopRejectedStack();
        throw error;
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
      for (const browser of plan.browsers) docker(["stop", "-t", String(BROWSER_STOP_S), browser.container], { allowFail: true });
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

    upgrade({ images, ids, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS, noStart = false }) {
      return locked(async () => {
        assertStable();
        const target = images ? stack.load(images) : ids;
        assertImages(target);
        const state = readState();
        if (!state.current) throw new Error("no current images; install first");
        const changed = state.current.runtime !== target.runtime || state.current.browser !== target.browser;
        if (noStart) {
          await quiesce("stage-upgrade");
          systemctl(["stop", SERVICE]);
          verifyStopped();
          writeState(record({ ...readState(), current: target, previous: changed ? state.current : state.previous }, { action: "stage-upgrade", result: "stopped", to: target }));
          return { changed, started: false };
        }
        checkLegacyVolumes(layout().browsers);
        if (state.current.runtime === target.runtime && state.current.browser === target.browser) return { changed: false };
        const quiesced = await quiesce("upgrade");
        const switched = await switchTo(target, state.current, "upgrade", readyTimeoutMs, quiesced);
        if (switched.ok) return { changed: true, ready: switched.ready };
        deps.log("upgrade: new stack failed or not ready; rolling back to the previous digests (volumes kept)");
        try { assertImages(state.current); }
        catch (error) {
          systemctl(["stop", SERVICE], { allowFail: true });
          await fence();
          verifyStopped();
          throw new Error(`upgrade failed; previous images incompatible, stack stopped and fenced: ${error.message}`);
        }
        const back = await switchTo(state.current, state.previous, "auto-rollback", readyTimeoutMs);
        throw new Error(back.ok ? "upgrade failed: rolled back to the previous digests"
          : "upgrade failed and the rolled back stack is not ready either; see abp-stack status and journalctl -u abp-stack");
      });
    },

    rollback({ readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
      return locked(async () => {
        assertStable();
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
        assertStable();
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
          iptables(["-A", "ABP-FENCE", ...fenceRule(layout().runtimePort)], { allowFail: true });
          writeState(record(readState(), { action: "rotate-keys", result: "failed", keys: done, error: error instanceof Error ? error.message : "failed" }));
          throw error;
        }
      });
    },

    /** Whole-stack assignment transaction. Even rollback creates a fresh execution generation. */
    setPrincipal(profileId, principalId, recovery) {
      return locked(async () => {
        if (install().tenancyMode === "shared") throw refusal("a shared machine has a profile per user: use add-profile/remove-profile");
        let journal = readState().transition;
        if (recovery) {
          if (!journal) throw new Error("no unfinished assignment transition");
          const options = recovery === "abort" ? journal.before : (journal.requested ?? journal.target);
          // The owner being left comes from the journal, not install.json (already the target after a commit).
          const leaving = recovery === "abort" ? (journal.requested ?? journal.target) : journal.before;
          const ownerIn = (config) => config.profiles.find((p) => p.profileId === journal.profileId).principalId;
          const target = { ...options, profiles: options.profiles.map((p) => p.profileId === journal.profileId ? { ...p, assignmentId: randomBytes(16).toString("hex") } : p) };
          writeState({ ...readState(), transition: { ...journal, target, phase: "prepared" } });
          await applyOwners(target, markVolumes(readState().profileVolumes, journal.profileId, profileVolumeName(journal.profileId, ownerIn(leaving)), profileVolumeName(journal.profileId, ownerIn(target))));
          return;
        }
        assertStable();
        const options = install();
        validConfig(options);
        const current = options.profiles.find((p) => p.profileId === profileId);
        if (!current) throw new Error(`unknown profile ${profileId}`);
        if (current.principalId === principalId) {
          await verifyAssignment(options);
          return;
        }
        const target = mergeInstallOptions(options, { profiles: options.profiles.map((p) => p.profileId === profileId ? { profileId, principalId, assignmentId: randomBytes(16).toString("hex") } : p) });
        const quiesced = await quiesce("set-principal");
        const beforeMarks = readState().profileVolumes;
        journal = { id: randomBytes(16).toString("hex"), profileId, before: options, target, requested: target, phase: "prepared", quiesced };
        writeState({ ...readState(), transition: journal });
        const marks = markVolumes(beforeMarks, profileId, profileVolumeName(profileId, current.principalId), profileVolumeName(profileId, principalId));
        try { await applyOwners(target, marks); }
        catch (error) {
          const rollback = { ...options, profiles: options.profiles.map((p) => p.profileId === profileId ? { ...p, assignmentId: randomBytes(16).toString("hex") } : p) };
          try {
            writeState({ ...readState(), transition: { ...journal, target: rollback, phase: "prepared" } });
            await applyOwners(rollback, beforeMarks);
          } catch (restoreError) {
            const failures = [];
            try { writeState({ ...readState(), transition: { ...readState().transition, phase: "blocked" } }); }
            catch (failure) { failures.push(`journal: ${failure.message}`); }
            systemctl(["stop", SERVICE], { allowFail: true });
            const service = systemctl(["is-active", SERVICE], { allowFail: true });
            if (!["inactive", "failed"].includes(service.stdout)) failures.push("supervisor stop unverified");
            // Docker containers can survive a failed systemd stop. Stop them directly, then inspect/kill.
            try { stopRejectedStack(); verifyStopped(); }
            catch (failure) { failures.push(`containers: ${failure.message}`); }
            try { const fenced = await fence(); if (!fenced.ok) failures.push(`fence: ${fenced.reason}`); }
            catch (failure) { failures.push(`fence: ${failure.message}`); }
            const safety = failures.length ? `safety unverified: ${failures.join("; ")}` : "stopped and fenced";
            throw new Error(`set-principal failed (${error.message}); restore failed (${restoreError.message}); ${safety}; use --resume or --abort`);
          }
          throw new Error(`set-principal failed (${error.message}); previous owner restored with a new assignment`);
        }
      });
    },

    migrateLegacyProfile(profileId, principalId, ownerVerified, resume = false) {
      return locked(async () => {
        const pending = readState().migrations?.find((m) => m.source === legacyProfileVolumeName(profileId) && m.phase !== "verified");
        if (!resume) {
          assertStable();
          if (readState().migrations?.some((m) => m.source === legacyProfileVolumeName(profileId))) throw new Error("legacy source already has a migration owner; reassignment is forbidden");
        }
        else if (readState().transition || !readState().migrationHold || !pending || pending.target !== profileVolumeName(profileId, principalId)) throw new Error("no matching incomplete migration to resume");
        if (!ownerVerified) throw new Error("legacy migration requires --owner-verified after confirming the actual owner");
        if (!install().profiles.some((p) => p.profileId === profileId) || typeof principalId !== "string" || !/^[^\u0000-\u001f\u007f]{1,256}$/.test(principalId)) throw new Error("valid profile and owner required");
        const source = legacyProfileVolumeName(profileId);
        const target = profileVolumeName(profileId, principalId);
        const info = volumeInfo(source);
        if (!info || info.Labels?.["ai.saycode.abp"] !== "stack") throw new Error("legacy volume missing or not owned by this stack");
        if (!resume && volumeInfo(target)) throw new Error("migration target already exists; never merged or overwritten");
        if (resume && !same(pending.volumeLabels, profileVolumeLabels(profileId, principalId))) throw new Error("migration owner labels differ from the journal");
        if (resume && volumeInfo(target)) validateVolume(target, pending.volumeLabels);
        assertImages(readState().current);
        if (!resume) await quiesce("migrate-legacy-profile");
        // Persistent hold also suppresses the supervisor if this process dies during stop/copy.
        const migration = pending ?? { id: randomBytes(16).toString("hex"), source, target, profileId, volumeLabels: profileVolumeLabels(profileId, principalId), ownerVerified: true, phase: "copying", atMs: deps.now() };
        writeState({ ...readState(), migrationHold: true, migrations: pending ? readState().migrations : [...(readState().migrations ?? []), migration] });
        systemctl(["stop", SERVICE]);
        verifyStopped();
        const old = docker(["ps", "-aq", "--filter", `label=${STACK_LABEL}`]).stdout.split("\n").filter(Boolean);
        for (const name of old) stopAndRemove(name, BROWSER_STOP_S);
        detached(source);
        detached(target);
        docker(["volume", "create", ...profileVolumeLabels(profileId, principalId).map((label) => `--label=${label}`), target]);
        const result = docker(["run", "--rm", `--name=abp-migrate-${migration.id}`, `--label=${STACK_LABEL}`, "--label=ai.saycode.abp.role=migration", "--network=none", "--read-only", "--user=0:0", "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=DAC_OVERRIDE", "--security-opt=no-new-privileges", "--entrypoint=python3", `--mount=type=volume,source=${source},target=/from,readonly`, `--mount=type=volume,source=${target},target=/to,volume-nocopy`, readState().current.browser, "-c", PROFILE_COPY, ...(resume ? ["--resume"] : [])]);
        const verified = JSON.parse(result.stdout);
        if (verified.verified !== true || !/^[0-9a-f]{64}$/.test(verified.sha256)) throw new Error("migration copy verification failed");
        const state = readState();
        writeState({ ...state, migrationHold: false, migrations: state.migrations.map((m) => m.target === target ? { ...m, phase: "verified", manifest: verified.sha256 } : m), legacyVolumes: (state.legacyVolumes ?? []).map((m) => m.volume === source ? { ...m, status: "migrated" } : m) });
        const options = install();
        await startServiceHeld(options);
        writeState({ ...readState(), applied: identity(options) });
        await releaseAdmission(options);
        clearStartRequest();
        return { source, target, verified: true };
      });
    },

    deleteProfileVolume(volume, confirmation) {
      return locked(async () => {
        assertStable();
        if (confirmation !== volume || typeof volume !== "string") throw new Error("exact volume name required in --confirm");
        if (layout().browsers.some((b) => b.volume === volume)) throw new Error("current owner volume cannot be deleted");
        const state = readState();
        if (state.migrations?.some((m) => [m.source, m.target].includes(volume) && m.phase !== "verified")) throw new Error("incomplete migration volume cannot be deleted");
        const info = volumeInfo(volume);
        if (!info || info.Labels?.["ai.saycode.abp"] !== "stack") throw new Error("volume is not owned by this stack");
        const labels = info.Labels;
        const legacy = (state.legacyVolumes ?? []).some((m) => m.volume === volume) || (state.migrations ?? []).some((m) => m.source === volume);
        if (!legacy && (labels["ai.saycode.abp.role"] !== "profile" || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(labels["ai.saycode.abp.profile"] ?? "") || !/^[0-9a-f]{16}$/.test(labels["ai.saycode.abp.principal"] ?? "") || volume !== `abp-profile-${labels["ai.saycode.abp.profile"]}-${labels["ai.saycode.abp.principal"]}`)) throw new Error("profile volume name/labels mismatch");
        detached(volume);
        docker(["volume", "rm", volume]);
        writeState(record({ ...state, profileVolumes: (state.profileVolumes ?? []).filter((m) => m.volume !== volume), legacyVolumes: (state.legacyVolumes ?? []).filter((m) => m.volume !== volume) }, { action: "delete-profile-volume", volume }));
      });
    },

    async status() {
      const plan = layout();
      const state = readState();
      const checks = [];
      const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
      check("migration hold", !state.migrationHold, JSON.stringify(state.migrations ?? []));
      const admin = await deps.adminReady();
      check("admission", admin?.admission === "open", admin?.admission ?? "unavailable");
      check("assignment transition", !state.transition, state.transition?.phase ?? "none");
      check("legacy quarantine", !(state.legacyVolumes ?? []).some((m) => m.status === "quarantined"), JSON.stringify(state.legacyVolumes ?? []));
      check("service", systemctl(["is-active", SERVICE], { allowFail: true }).stdout === "active");
      check("browser egress firewall", firewall(["check-egress"], { allowFail: true }).status === 0);
      const containers = [[plan.runtime.container, state.current?.runtime], ...plan.browsers.map((browser) => [browser.container, state.current?.browser])];
      for (const [name, image] of containers) {
        const [running, label] = docker(["inspect", "-f", `{{.State.Running}} ${IMAGE_LABEL}`, name], { allowFail: true }).stdout.split(" ");
        const pinned = Boolean(image) && label === image;
        check(`container ${name}`, running === "true" && pinned, `running=${running || "missing"} image=${pinned ? "pinned" : label || "none"}`);
      }
      for (const browser of plan.browsers) {
        try {
          validateVolume(browser.volume, browser.volumeLabels);
          check(`profile mount ${browser.container}`, hasExpectedProfileMount(browser), `expected ${browser.volume}`);
        } catch (error) { check(`profile mount ${browser.container}`, false, error.message); }
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
      // Informational: previous owners' volumes and orphaned volumes are retained indefinitely.
      const profileVolumes = docker(["volume", "ls", "-q", "--filter", "label=ai.saycode.abp.role=profile"], { allowFail: true });
      if (profileVolumes.status === 0) {
        const currentVolumes = plan.browsers.map((browser) => browser.volume);
        const marks = state.profileVolumes ?? [];
        const kept = marks.filter((mark) => mark.detachedAtMs !== undefined && !currentVolumes.includes(mark.volume));
        const oldest = kept.length ? new Date(Math.min(...kept.map((mark) => mark.detachedAtMs))).toISOString().slice(0, 10) : undefined;
        const unmarked = profileVolumes.stdout.split("\n").filter(Boolean).filter((volume) => !currentVolumes.includes(volume) && !marks.some((mark) => mark.volume === volume));
        check("profile volumes", true, `current ${currentVolumes.join(", ")}; kept ${kept.length}${oldest ? ` (oldest detached ${oldest})` : ""}; unmarked ${unmarked.length}`);
      } else {
        check("profile volumes", false, "docker volume ls failed");
      }
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
          [join(own, "runtime.Dockerfile"), "runtime.Dockerfile"], [join(own, "browser.Dockerfile"), "browser.Dockerfile"], [join(own, "browser-entrypoint.sh"), "browser-entrypoint.sh"], [join(own, "browser-shutdown.py"), "browser-shutdown.py"],
          [join(own, "chromium-policy.json"), "chromium-policy.json"]]) {
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
  let provisioning;
  // exitCode 1 (not 78): systemd restarts the service (Restart=always).
  const stop = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    deps.log("stopping: fence, drain, Runtime, browsers");
    // A first-use addition in progress gets up to 60 s (systemd allows 150 s); cut short, the next start settles it.
    const inFlight = provisioning && exitCode === 0 ? Promise.race([provisioning, deps.sleep(60_000)]) : Promise.resolve();
    inFlight.then(() => stack.stop()).then(() => process.exit(exitCode), (error) => {
      deps.log(`stop failed: ${error instanceof Error ? error.message : "failed"}`);
      process.exit(1);
    });
  };
  process.on("SIGTERM", () => stop());
  process.on("SIGINT", () => stop());
  await stack.start();
  // First-use profile requests run beside supervision, never blocking it (an addition takes a minute).
  const profileBackoff = new Map();
  const provision = setInterval(() => {
    if (stopping || provisioning) return;
    provisioning = stack.provisionRequestedProfiles(profileBackoff)
      .then((result) => {
        if (!result?.restartToSettle) return;
        deps.log("a profile change failed for good; restarting the service so its start settles it");
        stop(1);
      })
      .catch((error) => deps.log(`profile requests: ${error instanceof Error ? error.message : "failed"}`))
      .finally(() => { provisioning = undefined; });
  }, PROFILE_POLL_MS);
  provision.unref();
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
      await stack.up({ restart: args.includes("--restart") });
      console.log("ready");
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
      console.log(JSON.stringify(await stack.upgrade({ images, ids, readyTimeoutMs: timeout, noStart: args.includes("--no-start") })));
      return;
    }
    case "rollback": console.log(JSON.stringify(await stack.rollback({ readyTimeoutMs: timeout }))); return;
    case "rotate-keys": {
      const some = args.includes("--daemon-token") || args.includes("--vnc-password");
      await stack.rotateKeys({ daemonToken: !some || args.includes("--daemon-token"), vncPassword: !some || args.includes("--vnc-password") });
      return;
    }
    case "set-principal":
      if (args.includes("--resume") || args.includes("--abort")) await stack.setPrincipal(undefined, undefined, args.includes("--abort") ? "abort" : "resume");
      else {
        if (!args[0] || !args[1]) throw new Error("usage: abp-stack set-principal <profileId> <principalId> | --resume | --abort");
        await stack.setPrincipal(args[0], args[1]);
      }
      return;
    case "add-profile":
    case "remove-profile": {
      if (!args[0]) throw new Error(`usage: abp-stack ${command} <studio userId>${command === "remove-profile" ? " [--block]" : ""}`);
      const result = command === "add-profile" ? await stack.addProfile(args[0]) : await stack.removeProfile(args[0], { block: args.includes("--block") });
      console.log(JSON.stringify(result));
      return;
    }
    case "list-profiles": {
      const list = stack.listProfiles();
      if (args.includes("--json")) console.log(JSON.stringify(list, null, 2));
      else {
        for (const p of list.profiles) console.log(`${p.profileId}  ${p.principalId}  slot ${p.networkSlot}  ${p.running ? "running" : "stopped"}  ${p.volume}${p.removedAtMs ? `  (re-added; chats before ${new Date(p.removedAtMs).toISOString()} need a new chat)` : ""}`);
        for (const r of list.removed) console.log(`removed  ${r.principalId}${r.blocked ? "  (blocked)" : ""}`);
        console.log(`${list.capacity.used}/${list.capacity.max} profiles`);
      }
      return;
    }
    case "recover-profiles": await stack.recoverProfiles(); return;
    case "migrate-legacy-profile":
      return stack.migrateLegacyProfile(args[0], option(args, "--owner"), args.includes("--owner-verified"), args.includes("--resume"));
    case "delete-profile-volume":
      return stack.deleteProfileVolume(args[0], option(args, "--confirm"));
    default:
      throw new Error("usage: abp-stack up|down|emergency-stop|status|upgrade|rollback|rotate-keys|set-principal|add-profile|remove-profile|list-profiles|recover-profiles|migrate-legacy-profile|delete-profile-volume|load|build|run");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`abp-stack: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(error?.exitCode === 78 ? 78 : 1);
  });
}

