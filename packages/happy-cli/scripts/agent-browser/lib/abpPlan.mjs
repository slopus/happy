// Agent Browser execution machine H: everything abp-install and abp-stack
// generate (install options, /etc/abp/runtime.json, permissions, owner firewall
// rules, sudoers, tmpfiles, systemd units, seccomp profile, container
// arguments). Pure functions, no I/O, no dependency beyond node:crypto, so the
// installed copy runs with /usr/bin/node alone and the unit tests pin it.
// Errors name the field, never the value (issuer keys, tokens).
import { createHash, createPublicKey } from "node:crypto";

export const DEFAULT_RUNTIME_PORT = 38700;
export const PACKAGE_NAME = "@buzzni/happy-cli";
/** Fixed ids of the container users; host accounts reserve them so no login user shares them. */
export const IDS = { runtimeUid: 10870, browserUid: 10871 };
export const PATHS = {
  etc: "/etc/abp",
  installConfig: "/etc/abp/install.json",
  runtimeConfig: "/etc/abp/runtime.json",
  daemonEnv: "/etc/abp/happy-daemon.env",
  seccompProfile: "/etc/abp/seccomp-chromium.json",
  firewallRules: { 4: "/etc/abp/firewall.rules4", 6: "/etc/abp/firewall.rules6" },
  egressRules: { 4: "/etc/abp/egress.rules4", 6: "/etc/abp/egress.rules6" },
  varLib: "/var/lib/abp",
  daemonToken: "/var/lib/abp/daemon-token",
  secrets: "/var/lib/abp/secrets",
  runtimeSecrets: "/var/lib/abp/secrets/runtime",
  browserSecrets: "/var/lib/abp/secrets/browser",
  stackState: "/var/lib/abp/stack-state.json",
  /** Content digest of the installed Happy package (abp-install restarts the daemon and proxy when it changes). */
  happyDigest: "/var/lib/abp/happy-package.sha256",
  run: "/run/abp",
  brokerSocket: "/run/abp/broker.sock",
  adminSocket: "/run/abp/admin.sock",
  mcp: "/run/abp-mcp",
  work: "/work",
  libexec: "/usr/local/libexec/abp",
  launcher: "/usr/local/libexec/abp/claude-sbx-launch",
  firewallReader: "/usr/local/libexec/abp/abp-firewall-read",
  stackBin: "/usr/local/sbin/abp-stack",
  aplus: "/etc/aplus",
  sandboxPolicy: "/etc/aplus/sandbox-policy.json",
  egressPolicy: "/etc/aplus/claude-sandbox.json",
  sudoers: "/etc/sudoers.d/abp-agent-sbx",
  tmpfiles: "/etc/tmpfiles.d/abp.conf",
  units: "/etc/systemd/system",
  happyPrefix: "/opt/abp/happy",
  stackLock: "/run/abp-stack.lock",
  /** Serializes mutating operations (install, upgrade, rollback, rotate-keys, set-principal, up/down). */
  opsLock: "/run/abp-stack-ops.lock",
};
export const DEFAULT_BROWSER_SUBNET_POOL = "10.249.240.0/20";
/** The only profile release 1 installs (the Desktop requests it). */
export const RELEASE_PROFILE = "main";
const MAX_PROFILES = 16;
/** Container-side paths (fixed by the images). */
const IN_CONTAINER = { secrets: "/run/secrets/abp", vncPassword: "/run/secrets/abp/vnc-password", state: "/var/lib/abp", stateDir: "/var/lib/abp/state", profile: "/home/browser/profile" };
export const STACK_LABEL = "ai.saycode.abp=stack";

// Same lists as src/sandbox/egressProxy.ts (S1); abpPlan.test.ts compares with the preflight once both are in the tree.
const DENIED_IPV4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3"];
const DENIED_IPV6 = ["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"];

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const TEXT_ID = /^[^\u0000-\u001f\u007f]{1,256}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ipToInt = (ip) => ip.split(".").reduce((n, byte) => n * 256 + Number(byte), 0);
const intToIp = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");
/** [network, bits] of an aligned IPv4 CIDR, or undefined. */
function parseCidr(value) {
  const [ip, bits, extra] = String(value).split("/");
  const prefix = Number(bits);
  if (extra !== undefined || !IPV4.test(ip ?? "") || !/^\d{1,2}$/.test(bits ?? "") || prefix > 32) return undefined;
  const network = ipToInt(ip);
  return network % 2 ** (32 - prefix) === 0 ? [network, prefix] : undefined;
}
const inside = (cidr, outer) => {
  const [network, bits] = parseCidr(cidr);
  const [base, outerBits] = parseCidr(outer);
  return bits >= outerBits && Math.floor(network / 2 ** (32 - outerBits)) === Math.floor(base / 2 ** (32 - outerBits));
};

function fail(field, message) {
  throw new Error(`abp install option ${field}: ${message}`);
}
function bareOrigin(value, field) {
  let url;
  try { url = new URL(value); } catch { fail(field, "must be a bare origin such as https://shop.example"); }
  if (url.origin !== value || !["https:", "http:"].includes(url.protocol)) fail(field, "must be a bare origin such as https://shop.example");
  return value;
}
function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(field, `must be an integer ${min}..${max}`);
  return value;
}

/**
 * Install options (/etc/abp/install.json, no secrets) = the saved options with
 * the given flags applied. Validated as a whole, so a re-run without flags
 * keeps the machine as it was and a partial change cannot leave it invalid.
 * `machineId: "auto"` is resolved later from the agent's Happy settings.
 */
export function mergeInstallOptions(saved, flags) {
  const merged = {
    schemaVersion: 1,
    runtimePort: DEFAULT_RUNTIME_PORT,
    maxAgentWindows: 4,
    retentionDays: 7,
    viewerOrigins: [],
    egressDomains: [],
    sites: [],
    happyPrefix: PATHS.happyPrefix,
    browserSubnetPool: DEFAULT_BROWSER_SUBNET_POOL,
    denyCidrs: [],
    browserDns: [],
    // TEST ONLY (acceptance fixtures on a private address). Never set on a production machine;
    // `check` and `status` warn while it is non-empty.
    testAllowCidrs: [],
    ...saved,
    ...Object.fromEntries(Object.entries(flags).filter(([key, value]) => value !== undefined && key !== "issuers")),
  };
  if (flags.issuers !== undefined) merged.trustedIssuers = flags.issuers;
  if (!merged.agentProfileId || (flags.profiles && !flags.agentProfileId && !flags.profiles.some((p) => p.profileId === merged.agentProfileId))) {
    merged.agentProfileId = merged.profiles?.[0]?.profileId;
  }
  if (merged.schemaVersion !== 1) fail("schemaVersion", "must be 1");
  for (const field of ["machineId", "workspaceId"]) {
    if (typeof merged[field] !== "string" || !TEXT_ID.test(merged[field])) fail(field, "is required (1-256 printable characters)");
  }
  if (!Array.isArray(merged.profiles) || merged.profiles.length === 0) fail("profiles", "at least one --profile <id>=<principalId> is required");
  if (merged.profiles.length > MAX_PROFILES) fail("profiles", `at most ${MAX_PROFILES} (one /24 of the browser subnet pool each)`);
  const seen = new Set();
  for (const [index, profile] of merged.profiles.entries()) {
    if (!PROFILE_ID.test(profile?.profileId ?? "")) fail(`profiles[${index}].profileId`, "must be lowercase letters, digits and hyphens (max 31), it names containers and volumes");
    if (!TEXT_ID.test(profile.principalId ?? "")) fail(`profiles[${index}].principalId`, "is required");
    if (seen.has(profile.profileId)) fail(`profiles[${index}].profileId`, "is duplicated");
    seen.add(profile.profileId);
  }
  merged.profiles = merged.profiles.map(({ profileId, principalId }) => ({ profileId, principalId }));
  // Release 1: one dedicated user per machine and the Desktop asks for profile "main". The generators
  // below support several profiles; lift this check together with the Desktop when that ships.
  if (merged.profiles.length !== 1 || merged.profiles[0].profileId !== RELEASE_PROFILE) fail("profiles", `release 1 installs exactly one profile named ${RELEASE_PROFILE} (--profile ${RELEASE_PROFILE}=<studio userId>)`);
  if (!seen.has(merged.agentProfileId)) fail("agentProfileId", "must be one of the configured profiles");
  if (!Array.isArray(merged.trustedIssuers) || merged.trustedIssuers.length === 0) fail("trustedIssuers", "at least one --issuer <kid>=<public-key.pem> is required");
  merged.trustedIssuers = merged.trustedIssuers.map((issuer, index) => {
    if (!TEXT_ID.test(issuer?.kid ?? "")) fail(`trustedIssuers[${index}].kid`, "is required");
    // createPublicKey also accepts a private key (deriving its public half): refuse that, then keep only the canonical SPKI.
    let key;
    try {
      if (typeof issuer.publicKeyPem !== "string" || issuer.publicKeyPem.length > 4096 || /PRIVATE KEY/.test(issuer.publicKeyPem)) throw new Error();
      key = createPublicKey({ key: issuer.publicKeyPem, format: "pem" });
    } catch { key = undefined; }
    if (key?.asymmetricKeyType !== "ed25519") fail(`trustedIssuers[${index}].publicKeyPem`, "must be an Ed25519 public key (PEM, SPKI), never a private key");
    return { kid: issuer.kid, publicKeyPem: key.export({ type: "spki", format: "pem" }).toString() };
  });
  if (!Array.isArray(merged.sites)) fail("sites", "must be a JSON array of site policies");
  merged.sites.forEach((site, index) => bareOrigin(site?.origin, `sites[${index}].origin`));
  integer(merged.runtimePort, "runtimePort", 1024, 65535);
  integer(merged.maxAgentWindows, "maxAgentWindows", 1, 16);
  integer(merged.retentionDays, "retentionDays", 1, 365);
  merged.viewerOrigins.forEach((origin, index) => bareOrigin(origin, `viewerOrigins[${index}]`));
  if (merged.egressDomains.length > 64) fail("egressDomains", "at most 64");
  merged.egressDomains.forEach((domain, index) => { if (!DOMAIN.test(domain)) fail(`egressDomains[${index}]`, "must be an exact lowercase domain (no wildcard)"); });
  const pool = parseCidr(merged.browserSubnetPool);
  if (!pool || pool[1] !== 20 || !["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].some((range) => inside(merged.browserSubnetPool, range))) {
    fail("browserSubnetPool", "must be a private IPv4 /20 (one /24 per profile)");
  }
  if (!Array.isArray(merged.denyCidrs) || merged.denyCidrs.length > 256) fail("denyCidrs", "at most 256");
  merged.denyCidrs.forEach((cidr, index) => {
    const parsed = parseCidr(cidr);
    if (!parsed) fail(`denyCidrs[${index}]`, "must be an aligned IPv4 CIDR such as 10.20.0.0/16");
    // ipset hash:net cannot hold prefix 0; denying everything would also cut the browsers off entirely.
    if (parsed[1] === 0) fail(`denyCidrs[${index}]`, "must not be /0");
  });
  if (!Array.isArray(merged.testAllowCidrs) || merged.testAllowCidrs.length > 8) fail("testAllowCidrs", "at most 8");
  merged.testAllowCidrs.forEach((cidr, index) => {
    const parsed = parseCidr(cidr);
    if (!parsed || parsed[1] < 24) fail(`testAllowCidrs[${index}]`, "must be an aligned IPv4 CIDR no wider than /24");
  });
  if (!Array.isArray(merged.browserDns) || merged.browserDns.length > 8) fail("browserDns", "at most 8");
  merged.browserDns.forEach((ip, index) => { if (!IPV4.test(ip)) fail(`browserDns[${index}]`, "must be an IPv4 address"); });
  // The sandbox launcher and preflight require root-owned, non-writable executables outside private homes and /tmp.
  if (!/^\/[A-Za-z0-9._/-]+$/.test(merged.happyPrefix) || /(^|\/)\.\.?(\/|$)/.test(merged.happyPrefix) || /^\/(home|tmp|var\/tmp|root|work|run)(\/|$)/.test(merged.happyPrefix)) {
    fail("happyPrefix", "must be an absolute root-owned location outside /home, /root, /tmp, /var/tmp, /run and /work");
  }
  // abp-install replaces the whole prefix on a package update, so it must be a dedicated directory: canonical
  // (no trailing or doubled slash), at least two levels deep and not a shared system prefix.
  if (/\/$|\/\//.test(merged.happyPrefix) || merged.happyPrefix.split("/").length < 3
      || /^\/(usr|usr\/local|usr\/lib|usr\/share|usr\/local\/lib|usr\/local\/share|opt\/local|var\/lib|etc\/opt|srv\/local)$/.test(merged.happyPrefix)) {
    fail("happyPrefix", "must be a dedicated directory such as /opt/abp/happy (the installer replaces it), not a shared prefix");
  }
  return merged;
}

/** /etc/abp/runtime.json (S2 runtimeConfig schema). Profiles carry identity only; the stack passes endpoints in ABP_PROFILES. */
export function runtimeConfig(install, { sessionGid, daemonTokenSha256 }) {
  if (!/^[0-9a-f]{64}$/.test(daemonTokenSha256 ?? "")) fail("daemonTokenSha256", "must be the hex SHA-256 of the daemon token");
  integer(sessionGid, "abp-session gid", 1, 2 ** 31 - 1);
  return {
    schemaVersion: 1,
    authMode: "production",
    machineId: install.machineId,
    workspaceId: install.workspaceId,
    profiles: install.profiles.map(({ profileId, principalId }) => ({ profileId, principalId })),
    trustedIssuers: install.trustedIssuers,
    sites: install.sites,
    // Inside the container; the stack publishes it on 127.0.0.1 only, same port number.
    runtimeHost: "0.0.0.0",
    runtimePort: install.runtimePort,
    brokerSocketPath: PATHS.brokerSocket,
    adminSocketPath: PATHS.adminSocket,
    brokerSocketGid: sessionGid,
    daemonTokenSha256,
    ...install.viewerOrigins.length ? { viewerOrigins: install.viewerOrigins } : {},
    maxAgentWindows: install.maxAgentWindows,
    retentionDays: install.retentionDays,
  };
}

/**
 * Every path abp-install owns, with owner, group and mode. abp-install applies
 * and checks this table; `secret` rows are generated only when missing.
 * type: dir | file (content written by the installer) | secret | exec | tmpfs-dir (tmpfiles.d)
 */
export function permissionTable() {
  const row = (path, type, owner, group, mode, extra = {}) => ({ path, type, owner, group, mode, ...extra });
  return [
    row(PATHS.etc, "dir", "root", "root", "0700"),
    row(PATHS.installConfig, "file", "root", "root", "0600"),
    row(PATHS.runtimeConfig, "file", "root", "root", "0600"),
    row(PATHS.daemonEnv, "file", "root", "root", "0644"),
    row(PATHS.seccompProfile, "file", "root", "root", "0644"),
    row(PATHS.firewallRules[4], "file", "root", "root", "0644"),
    row(PATHS.firewallRules[6], "file", "root", "root", "0644"),
    row(PATHS.egressRules[4], "file", "root", "root", "0644"),
    row(PATHS.egressRules[6], "file", "root", "root", "0644"),
    // agent traverses to its token (abp-session); agent-sbx cannot enter.
    row(PATHS.varLib, "dir", "root", "abp-session", "0710"),
    row(PATHS.daemonToken, "secret", "agent", "agent", "0400", { secret: true }),
    row(PATHS.secrets, "dir", "root", "root", "0711"),
    // Readable by the Runtime both before (root, via group 0) and after it drops to uid 10870.
    row(PATHS.runtimeSecrets, "dir", "abp-runtime", "root", "0550"),
    row(`${PATHS.runtimeSecrets}/vnc-password`, "secret", "abp-runtime", "root", "0440", { secret: true }),
    row(PATHS.browserSecrets, "dir", "abp-browser", "abp-browser", "0500"),
    row(`${PATHS.browserSecrets}/vnc-password`, "secret", "abp-browser", "abp-browser", "0400", { secret: true }),
    row(PATHS.stackState, "file", "root", "root", "0600"),
    row(PATHS.happyDigest, "file", "root", "root", "0600"),
    row(PATHS.run, "tmpfs-dir", "root", "abp-session", "0750"),
    row(PATHS.mcp, "tmpfs-dir", "agent", "agent-sbx", "0710"),
    row("/home/agent", "dir", "agent", "agent", "0700"),
    row("/home/agent-sbx", "dir", "agent-sbx", "agent-sbx", "0700"),
    row(PATHS.work, "dir", "agent", "abp-work", "2770"),
    row(PATHS.libexec, "dir", "root", "root", "0755"),
    row(PATHS.launcher, "exec", "root", "root", "0755"),
    row(PATHS.firewallReader, "exec", "root", "abp-session", "4750"),
    row(`${PATHS.libexec}/abp-firewall`, "exec", "root", "root", "0755"),
    row(`${PATHS.libexec}/abp-stack.mjs`, "exec", "root", "root", "0644"),
    row(`${PATHS.libexec}/lib/abpPlan.mjs`, "exec", "root", "root", "0644"),
    row(PATHS.stackBin, "exec", "root", "root", "0755"),
    row(PATHS.aplus, "dir", "root", "root", "0755"),
    row(PATHS.sandboxPolicy, "file", "root", "root", "0644"),
    row(PATHS.sudoers, "file", "root", "root", "0440"),
    row(PATHS.tmpfiles, "file", "root", "root", "0644"),
  ];
}

/** Ordered OUTPUT prefix of src/sandbox/sandboxPreflight.ts firewallRules (S1): installed before every other OUTPUT rule. */
export function firewallRules(family, sandboxUid, proxyUid) {
  const sbx = `-A OUTPUT -m owner --uid-owner ${sandboxUid}`;
  const proxy = `-A OUTPUT -m owner --uid-owner ${proxyUid}`;
  const rules = family === 4 ? [`-A OUTPUT -d 127.0.0.1/32 -p tcp -m owner --uid-owner ${sandboxUid} -m tcp --dport 3128 -j ACCEPT`] : [];
  rules.push(`${sbx} -j REJECT`);
  if (family === 4) rules.push(`-A OUTPUT -d 127.0.0.1/32 -p tcp -m owner --uid-owner ${proxyUid} -m tcp --sport 3128 -m conntrack --ctstate ESTABLISHED -j ACCEPT`);
  for (const cidr of family === 4 ? DENIED_IPV4 : DENIED_IPV6) rules.push(`-A OUTPUT -d ${cidr} -m owner --uid-owner ${proxyUid} -j REJECT`);
  rules.push(`-A OUTPUT${family === 6 ? " -d 2000::/3" : ""} -p tcp -m owner --uid-owner ${proxyUid} -m tcp --dport 443 -j ACCEPT`, `${proxy} -j REJECT`);
  return rules;
}

/** firewall.rules4/6: the S1 owner prefix, then (IPv4) the jump to the stack's admission fence chain. */
export function firewallRulesFile(family, sandboxUid, proxyUid) {
  return `${[...firewallRules(family, sandboxUid, proxyUid), ...family === 4 ? ["-A OUTPUT -j ABP-FENCE"] : []].join("\n")}\n`;
}

/**
 * Admission fence (upgrade, key rotation, stop): host-originated packets to the Runtime API port are reset,
 * including requests on kept-alive connections, while the Runtime finishes running batches. The published
 * port and the container port are the same number, so this matches both the docker-proxy and the DNAT path.
 */
export function fenceRule(runtimePort) {
  return ["-p", "tcp", "-m", "tcp", "--dport", String(runtimePort), "-j", "REJECT", "--reject-with", "tcp-reset"];
}

/**
 * Browser egress (FORWARD via DOCKER-USER, host via INPUT). Pages may reach public addresses only:
 * private, special, metadata, host and deployment ranges are rejected, except DNS to the configured
 * resolvers. The Runtime may only reach its own browser; the browser may only answer the Runtime.
 * Rules are in iptables-save form so abp-firewall can compare them with the live chains.
 * IPv6: browser networks are IPv4-only, so everything IPv6 from a browser bridge is rejected.
 */
export function egressRules(layout, install) {
  const chain = [];
  for (const browser of layout.browsers) {
    const b = `${browser.browserIp}/32`;
    const r = `${browser.runtimeIp}/32`;
    chain.push(`-s ${r} -d ${b} -j RETURN`);
    chain.push(`-s ${b} -d ${r} -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j RETURN`);
    for (const dns of install.browserDns) {
      chain.push(`-s ${b} -d ${dns}/32 -p udp -m udp --dport 53 -j RETURN`, `-s ${b} -d ${dns}/32 -p tcp -m tcp --dport 53 -j RETURN`);
    }
    for (const cidr of install.testAllowCidrs ?? []) {
      chain.push(`-s ${b} -d ${cidr} -j RETURN`, `-s ${cidr} -d ${b} -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j RETURN`);
    }
    chain.push(`-s ${b} -m set --match-set abp-deny4 dst -j REJECT`, `-s ${b} -j RETURN`);
  }
  chain.push("-j REJECT");
  return {
    4: {
      // A /32 is written as the bare host: ipset save reports it that way and check-egress compares the two.
      sets: { "abp-deny4": [...new Set([...DENIED_IPV4, ...install.denyCidrs].map((cidr) => cidr.replace(/\/32$/, "")))] },
      chains: { "ABP-EGRESS": chain, "ABP-INPUT": ["-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN", "-j REJECT"] },
      jumps: [["DOCKER-USER", "-i br-abp+ -j ABP-EGRESS"], ["INPUT", "-i br-abp+ -j ABP-INPUT"]],
    },
    6: {
      sets: {},
      chains: { "ABP-EGRESS": ["-j REJECT"], "ABP-INPUT": ["-j REJECT"] },
      jumps: [["FORWARD", "-i br-abp+ -j ABP-EGRESS"], ["INPUT", "-i br-abp+ -j ABP-INPUT"]],
    },
  };
}

/** egress.rules4/6 for abp-firewall: `set <name> <cidr>`, `chain <name> <spec>`, `jump <parent> <spec>` lines. */
export function egressRulesFile(rules) {
  const lines = [];
  for (const [name, members] of Object.entries(rules.sets)) for (const cidr of members) lines.push(`set ${name} ${cidr}`);
  for (const [name, specs] of Object.entries(rules.chains)) for (const spec of specs) lines.push(`chain ${name} ${spec}`);
  for (const [parent, spec] of rules.jumps) lines.push(`jump ${parent} ${spec}`);
  return `${lines.join("\n")}\n`;
}

export function sudoersDropIn() {
  return [
    "# Managed by abp-install. agent may start only the fixed Claude sandbox launcher as agent-sbx.",
    "Defaults:agent env_reset,!use_pty",
    `agent ALL=(agent-sbx) NOPASSWD: ${PATHS.launcher} 0`,
    "",
  ].join("\n");
}

export function tmpfilesConf() {
  return [
    "# Managed by abp-install: Runtime broker/admin sockets and per-session MCP sockets.",
    `d ${PATHS.run} 0750 root abp-session -`,
    `d ${PATHS.mcp} 0710 agent agent-sbx -`,
    "",
  ].join("\n");
}

/** Default sandbox config of H's daemon sessions (S1 whole-process sandbox; network via the egress proxy). */
const SESSION_SANDBOX_CONFIG = { enabled: true, workspaceRoot: "/work", sessionIsolation: "workspace", extraWritePaths: [], networkMode: "allowed" };

export function daemonEnv(install) {
  return [
    "# Managed by abp-install. No secret here: the daemon reads its broker token from the file below.",
    `HAPPY_BROWSER_TASK_RUNTIME_URL=http://127.0.0.1:${install.runtimePort}`,
    `HAPPY_BROWSER_TASK_BROKER_SOCKET=${PATHS.brokerSocket}`,
    `HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE=${PATHS.daemonToken}`,
    `HAPPY_BROWSER_TASK_PROFILE_ID=${install.agentProfileId}`,
    // The machine policy is mandatory: a session without an enabled sandbox config refuses to
    // start. Every daemon session gets this one (writes bounded to its /work workspace).
    `HAPPY_PROJECT_SANDBOX_CONFIG='${JSON.stringify(SESSION_SANDBOX_CONFIG)}'`,
    "",
  ].join("\n");
}

export function systemdUnits({ happyPrefix = PATHS.happyPrefix } = {}) {
  const packageDir = `${happyPrefix}/lib/node_modules/${PACKAGE_NAME}`;
  const unit = (lines) => `# Managed by abp-install.\n${lines.join("\n")}\n`;
  return {
    "abp-firewall.service": unit([
      "[Unit]",
      "Description=Agent Browser owner firewall rules (agent-sbx, abp-proxy)",
      "DefaultDependencies=no",
      "After=local-fs.target",
      "Wants=network-pre.target",
      "Before=network-pre.target abp-egress-proxy.service abp-stack.service abp-happy-daemon.service",
      "",
      "[Service]",
      "Type=oneshot",
      "RemainAfterExit=yes",
      `ExecStart=${PATHS.libexec}/abp-firewall apply`,
      `ExecReload=${PATHS.libexec}/abp-firewall apply`,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ]),
    "abp-egress-proxy.service": unit([
      "[Unit]",
      "Description=Agent Browser Claude egress proxy (CONNECT, public addresses only)",
      "Requires=abp-firewall.service",
      "After=abp-firewall.service network-online.target systemd-resolved.service",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "User=abp-proxy",
      "Group=abp-proxy",
      `ExecStart=/usr/bin/node ${packageDir}/dist/sandbox/egressProxyMain.mjs`,
      "Restart=always",
      "RestartSec=2",
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
      "PrivateTmp=yes",
      "ProtectSystem=strict",
      "ProtectHome=yes",
      "PrivateDevices=yes",
      // AF_UNIX: glibc's nss-resolve asks systemd-resolved over its socket (no DNS through the firewall).
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ]),
    "abp-egress.service": unit([
      "[Unit]",
      "Description=Agent Browser browser egress firewall (DOCKER-USER, INPUT)",
      // Restarted with Docker, which rebuilds its own chains; abp-stack also checks the rules before starting containers.
      "PartOf=docker.service",
      "After=docker.service abp-firewall.service",
      "Before=abp-stack.service",
      "",
      "[Service]",
      "Type=oneshot",
      "RemainAfterExit=yes",
      `ExecStart=${PATHS.libexec}/abp-firewall apply-egress`,
      `ExecReload=${PATHS.libexec}/abp-firewall apply-egress`,
      "",
      "[Install]",
      "WantedBy=multi-user.target docker.service",
    ]),
    "abp-stack.service": unit([
      "[Unit]",
      "Description=Agent Browser stack (Runtime + one browser per profile)",
      "Requires=docker.service abp-firewall.service abp-egress.service",
      "After=docker.service abp-firewall.service abp-egress.service systemd-tmpfiles-setup.service network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      // -F (no fork): node is the main process and gets SIGTERM, so it can fence, drain and stop the containers.
      `ExecStart=/usr/bin/flock -n -F ${PATHS.stackLock} ${PATHS.stackBin} run`,
      "KillMode=mixed",
      // Drain (up to 60 s) + Runtime stop (30 s) + browser stops.
      "TimeoutStopSec=150",
      "Restart=always",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ]),
    "abp-happy-daemon.service": unit([
      "[Unit]",
      "Description=Happy daemon for the Agent Browser execution machine",
      "Requires=abp-firewall.service",
      "Wants=abp-egress-proxy.service abp-stack.service network-online.target",
      "After=abp-firewall.service abp-egress-proxy.service abp-stack.service network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "User=agent",
      "Group=agent",
      "WorkingDirectory=/home/agent",
      "Environment=HOME=/home/agent",
      `EnvironmentFile=${PATHS.daemonEnv}`,
      `ExecStart=${happyPrefix}/bin/happy daemon start-sync`,
      `ExecStop=${happyPrefix}/bin/happy daemon stop`,
      // Sessions outlive a daemon restart, as with `happy daemon stop` outside systemd.
      "KillMode=process",
      "Restart=always",
      "RestartSec=5",
      "UMask=0077",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ]),
  };
}

/**
 * Docker's default seccomp profile (vendored, moby/profiles seccomp/v0.2.3)
 * plus the namespace calls of Chromium's own sandbox: it creates user, PID and
 * network namespaces (clone, unshare) and chroots its sandboxed processes into an
 * empty directory. The default profile allows these only with CAP_SYS_ADMIN, which
 * the container must not have. clone/unshare stay denied for mount, UTS, IPC and
 * cgroup namespaces, setns stays denied; everything else is as in the default.
 */
// CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC must stay clear; CLONE_NEWUSER/NEWPID/NEWNET may be set.
const FORBIDDEN_NAMESPACE_FLAGS = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000;
// Docker/libseccomp masked compare: (arg & value) == valueTwo.
const nsArg = (index) => ({ index, value: FORBIDDEN_NAMESPACE_FLAGS, valueTwo: 0, op: "SCMP_CMP_MASKED_EQ" });

export function chromiumSeccompProfile(base) {
  if (base?.defaultAction !== "SCMP_ACT_ERRNO" || !Array.isArray(base.syscalls)) throw new Error("seccomp base must be a default-deny profile");
  return {
    ...base,
    syscalls: [
      ...base.syscalls,
      { names: ["chroot"], action: "SCMP_ACT_ALLOW", comment: "Chromium chroots its sandboxed processes into an empty directory (abp-install)" },
      { names: ["clone"], action: "SCMP_ACT_ALLOW", args: [nsArg(0)], excludes: { arches: ["s390", "s390x"] }, comment: "Chromium sandbox: user/PID/net namespaces only (abp-install)" },
      { names: ["clone"], action: "SCMP_ACT_ALLOW", args: [nsArg(1)], includes: { arches: ["s390", "s390x"] }, comment: "s390 clone argument order (abp-install)" },
      { names: ["unshare"], action: "SCMP_ACT_ALLOW", args: [nsArg(0)], comment: "Chromium sandbox: user/PID/net namespaces only (abp-install)" },
    ],
  };
}

/**
 * Production layout: one bridge per profile shared only by that browser and the Runtime.
 * Profile i gets the i-th /24 of the browser subnet pool (gateway .1, browser .2, Runtime .3) and a
 * bridge named br-abp-<8 hex of sha256(profileId)> (15 characters, the Linux limit), so the egress
 * firewall can name exact addresses and match every browser bridge with br-abp+.
 */
export function stackLayout(install) {
  const [pool] = parseCidr(install.browserSubnetPool ?? DEFAULT_BROWSER_SUBNET_POOL);
  const browsers = install.profiles.map(({ profileId }, index) => {
    const base = pool + index * 256;
    return {
      profileId,
      container: `abp-browser-${profileId}`,
      alias: `browser-${profileId}`,
      network: `abp-net-${profileId}`,
      volume: `abp-profile-${profileId}`,
      bridge: `br-abp-${createHash("sha256").update(profileId).digest("hex").slice(0, 8)}`,
      subnet: `${intToIp(base)}/24`,
      gateway: intToIp(base + 1),
      browserIp: intToIp(base + 2),
      runtimeIp: intToIp(base + 3),
    };
  });
  return {
    runtimePort: install.runtimePort,
    networks: browsers.map((browser) => browser.network),
    volumes: ["abp-state", ...browsers.map((browser) => browser.volume)],
    browsers,
    runtime: {
      container: "abp-runtime",
      alias: "runtime",
      network: browsers[0].network,
      ip: browsers[0].runtimeIp,
      attach: browsers.slice(1).map((browser) => ({ network: browser.network, ip: browser.runtimeIp })),
      volume: "abp-state",
    },
  };
}

export function networkCreateArgs(browser) {
  return ["network", "create", "--driver=bridge", `--label=${STACK_LABEL}`, `--subnet=${browser.subnet}`, `--gateway=${browser.gateway}`,
    `--opt=com.docker.network.bridge.name=${browser.bridge}`, browser.network];
}

function imageRef(image) {
  if (!IMAGE_ID.test(image ?? "")) throw new Error("image must be a content digest (sha256:<64 hex>)");
  return image;
}

const logOpts = ["--log-driver=json-file", "--log-opt=max-size=10m", "--log-opt=max-file=5"];

/** `docker create` arguments for the Runtime; the other profile networks are connected before start. */
export function runtimeCreateArgs(layout, image) {
  const endpoints = layout.browsers.map((browser) => ({
    profileId: browser.profileId,
    cdpHttpUrl: `http://${browser.alias}:9223`,
    instanceUrl: `http://${browser.alias}:9224/instance`,
    vncAddress: `${browser.alias}:5900`,
  }));
  return [
    "create", `--name=${layout.runtime.container}`, `--label=${STACK_LABEL}`, "--label=ai.saycode.abp.role=runtime", `--label=ai.saycode.abp.image=${imageRef(image)}`,
    `--network=${layout.runtime.network}`, `--ip=${layout.runtime.ip}`, `--network-alias=${layout.runtime.alias}`,
    // S2 production start: root with only SETUID/SETGID to read the root-only config and bind the sockets, then drop.
    "--user=0:0", "--cap-drop=ALL", "--cap-add=SETUID", "--cap-add=SETGID", "--security-opt=no-new-privileges",
    "--read-only", "--tmpfs=/tmp:rw,size=64m", "--pids-limit=256", "--memory=1g", "--cpus=1", "--restart=no", ...logOpts,
    `--mount=type=volume,source=${layout.runtime.volume},target=${IN_CONTAINER.state}`,
    `--mount=type=bind,source=${PATHS.run},target=${PATHS.run}`,
    `--mount=type=bind,source=${PATHS.runtimeConfig},target=${PATHS.runtimeConfig},readonly`,
    `--mount=type=bind,source=${PATHS.runtimeSecrets},target=${IN_CONTAINER.secrets},readonly`,
    `--env=ABP_STATE_DIR=${IN_CONTAINER.stateDir}`,
    `--env=ABP_CONFIG_FILE=${PATHS.runtimeConfig}`,
    `--env=ABP_VNC_PASSWORD_FILE=${IN_CONTAINER.vncPassword}`,
    `--env=ABP_PROFILES=${JSON.stringify(endpoints)}`,
    `--publish=127.0.0.1:${layout.runtimePort}:${layout.runtimePort}`,
    image,
  ];
}

export function browserCreateArgs(layout, browser, image) {
  const uid = IDS.browserUid;
  const tmpfs = (path, size) => `--tmpfs=${path}:rw,uid=${uid},gid=${uid},size=${size}`;
  return [
    "create", `--name=${browser.container}`, `--label=${STACK_LABEL}`, "--label=ai.saycode.abp.role=browser", `--label=ai.saycode.abp.profile=${browser.profileId}`, `--label=ai.saycode.abp.image=${imageRef(image)}`,
    `--network=${browser.network}`, `--ip=${browser.browserIp}`, `--network-alias=${browser.alias}`,
    `--user=${uid}:${uid}`, "--cap-drop=ALL", "--security-opt=no-new-privileges", `--security-opt=seccomp=${PATHS.seccompProfile}`,
    "--read-only", "--tmpfs=/tmp:rw,size=128m", tmpfs("/run/abp", "1m"), tmpfs("/home/browser/.cache", "64m"), tmpfs("/home/browser/.config", "64m"), tmpfs("/home/browser/.local", "64m"),
    "--pids-limit=512", "--memory=2g", "--cpus=2", "--shm-size=256m", "--restart=no", ...logOpts,
    `--mount=type=volume,source=${browser.volume},target=${IN_CONTAINER.profile}`,
    `--mount=type=bind,source=${PATHS.browserSecrets},target=${IN_CONTAINER.secrets},readonly`,
    `--env=ABP_CDP_HOST=${browser.alias}:9223`,
    image,
  ];
}
