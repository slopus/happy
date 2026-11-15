import { createHash } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import {
  COMPUTER_CACHE_ENV,
  MAX_DESKTOP_DISPLAY,
  screenPorts,
} from "@rakazo/core/node/desktop-runtime";
import type Docker from "dockerode";
import type { ComputerLocale } from "./computer-locale.js";
import { computerLocaleEnv } from "./computer-locale.js";

/**
 * The computer image. RAKAZO_COMPUTER_IMAGE_TAG is appended the way Compose does, so a
 * supervisor started outside Compose pulls the same published tag instead of an untagged
 * (`:latest`) name. An image that already carries a tag or digest is used as is.
 */
export function resolveComputerImage(
  image = process.env.RAKAZO_COMPUTER_IMAGE,
  tag = process.env.RAKAZO_COMPUTER_IMAGE_TAG,
): string {
  const name = image?.trim();
  if (!name) return "rakazo/computer:local";
  const wantedTag = tag?.trim();
  const lastSegment = name.slice(name.lastIndexOf("/") + 1);
  if (!wantedTag || name.includes("@") || lastSegment.includes(":")) return name;
  return `${name}:${wantedTag}`;
}

export const COMPUTER_IMAGE = resolveComputerImage();

/** The files from infra/sandboxes/computer the supervisor sends when it builds the image locally. */
export const COMPUTER_IMAGE_CONTEXT_FILES = [
  "Dockerfile",
  "apt-security.sh",
  "start.sh",
  "user-env.sh",
  "control.py",
  "xcapture.c",
  "rakazo-browser",
  "rakazo-focus-or-launch",
  "rakazo-page-browser",
  "page_secrets.py",
  "install-chrome-use.sh",
  "rakazo-browser.desktop",
  "browser-policy.json",
  "embed.html",
  "clipboard-bridge.js",
  "mobile-keyboard.js",
  "fluxbox.init",
  "fluxbox.apps",
  "fluxbox.menu",
  "rakazo-local-bin.sh",
] as const;

/**
 * Docker's rule for a name that carries its registry: the first path component has a "." or
 * ":", is "localhost", or has an uppercase letter. The supervisor pulls only such names, never an
 * unqualified one that Docker would look up on Docker Hub, where anyone could register
 * rakazo/computer.
 */
export function isRegistryQualifiedImage(image: string): boolean {
  const slash = image.indexOf("/");
  if (slash < 0) return false;
  const host = image.slice(0, slash);
  return /[.:A-Z]/.test(host) || host === "localhost";
}

export const COMPUTER_UID = 1000;
export const COMPUTER_GID = 1000;
export const COMPUTER_USER = `${COMPUTER_UID}:${COMPUTER_GID}`;

export { screenPorts };
export const COMPUTER_CONTROL_PORT = 7070;
export const SCREEN_HOST = process.env.SANDBOX_SCREEN_HOST ?? "127.0.0.1";
export type ScreenNetworkMode = "published" | "internal" | "isolated";

export function resolveTeamScreenLimit(value = process.env.SANDBOX_TEAM_SCREEN_LIMIT): number {
  if (value === undefined || value.trim() === "" || isUnlimited(value)) return MAX_DESKTOP_DISPLAY;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      "SANDBOX_TEAM_SCREEN_LIMIT must be a positive integer, or 0 for no configured cap",
    );
  }
  return Math.min(limit, MAX_DESKTOP_DISPLAY);
}

export function resolveSpaceComputerLimit(
  value = process.env.SANDBOX_MAX_COMPUTERS_PER_SPACE,
): number {
  if (value === undefined || value.trim() === "" || isUnlimited(value)) return 0;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      "SANDBOX_MAX_COMPUTERS_PER_SPACE must be a positive integer, or 0 for no configured cap",
    );
  }
  return limit;
}

/**
 * Resource ceilings for a bot computer, which runs untrusted page content: one
 * runaway page must not starve the host or sibling bots. Set any of these to
 * "0", "none" or "unlimited" to opt out.
 */
const DEFAULT_COMPUTER_MEMORY = "2g";
const DEFAULT_COMPUTER_CPUS = "2";
const DEFAULT_COMPUTER_PIDS_LIMIT = "2048";
/** The daemon refuses HostConfig.Memory below this at container creation. */
const MIN_DOCKER_MEMORY_BYTES = 6 * 1024 ** 2;

const MEMORY_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};

function isUnlimited(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === "0" || value === "unlimited" || value === "none";
}

/** Bytes from a docker-style size string ("2g", "1536m", "1073741824"). */
export function parseMemoryBytes(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`${name} must be a size like "2g", "1536m" or a byte count, received "${raw}"`);
  }
  const scale = MEMORY_UNITS[(match[2] ?? "b").toLowerCase()] ?? 1;
  const bytes = Math.floor(Number(match[1]) * scale);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${name} must resolve to a positive byte count, received "${raw}"`);
  }
  // The daemon rejects a limit under 6 MiB at container creation. Catching it here turns a
  // per-bot 500 at the first `POST /computers` into a startup failure that names the variable.
  if (bytes < MIN_DOCKER_MEMORY_BYTES) {
    throw new Error(`${name} must be at least 6m, Docker's minimum, received "${raw}"`);
  }
  return bytes;
}

/** Docker NanoCpus (1e9 per core) from a CPU count like "1.5". */
export function parseNanoCpus(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const value = Number(raw.trim());
  // Tiny positives floor to 0 nanocpus (Docker reads as unlimited). Huge values leave the
  // safe-integer range or become Infinity. Validate the converted number either way.
  const nanoCpus = Math.floor(value * 1e9);
  if (!Number.isSafeInteger(nanoCpus) || nanoCpus <= 0) {
    throw new Error(`${name} must be a positive number of CPUs, received "${raw}"`);
  }
  return nanoCpus;
}

function parsePidsLimit(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/** An unset variable and one present but blank both mean "use the default". */
function envOrDefault(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

export function computerResourceLimits() {
  const memoryBytes = parseMemoryBytes(
    "RAKAZO_COMPUTER_MEMORY",
    envOrDefault("RAKAZO_COMPUTER_MEMORY", DEFAULT_COMPUTER_MEMORY),
  );
  const nanoCpus = parseNanoCpus(
    "RAKAZO_COMPUTER_CPUS",
    envOrDefault("RAKAZO_COMPUTER_CPUS", DEFAULT_COMPUTER_CPUS),
  );
  const pidsLimit = parsePidsLimit(
    "RAKAZO_COMPUTER_PIDS_LIMIT",
    envOrDefault("RAKAZO_COMPUTER_PIDS_LIMIT", DEFAULT_COMPUTER_PIDS_LIMIT),
  );
  return {
    // Memory and MemorySwap are set together: leaving MemorySwap unset lets the
    // container swap to twice Memory, so the ceiling would not hold.
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    NanoCpus: nanoCpus,
    PidsLimit: pidsLimit,
  };
}

export function resolveScreenNetworkMode(value: string | undefined): ScreenNetworkMode {
  if (!value || value === "published") return "published";
  if (value === "internal" || value === "isolated") return value;
  throw new Error(`Unsupported SANDBOX_SCREEN_NETWORK value: ${value}`);
}

/**
 * Paws `proxy` mode uses an internal bridge with isolated gateway mode and a
 * public-only HTTP proxy; it never falls back to direct networking.
 * Egress policy for per-bot computer networks. `open` gives full outbound access,
 * including the host's bridge addresses, the LAN, and link-local cloud metadata
 * endpoints. `restricted` keeps public internet egress but lets the operator drop
 * everything else with one host-side iptables rule set — the supervisor gives each
 * computer network a deterministic bridge interface name so the rules match by
 * interface (`-i rakazo-c+`) instead of ephemeral subnets. Enforcement lives on the
 * Docker host (infra/compose/restrict-computer-egress.sh) and is verified before
 * computers start (egress-probe.ts). The Compose stacks default to `auto`: restricted
 * when that check passes, open otherwise, so a stack installed before the rules
 * existed keeps working on upgrade. Unset here means a host-run supervisor, usually
 * on Docker Desktop, whose VM-hosted bridges the host rules cannot reach, so it stays
 * open.
 */
export type ComputerEgressMode = "open" | "restricted" | "proxy";
export type ComputerEgressSetting = ComputerEgressMode | "auto";

export function resolveComputerEgressMode(
  value = process.env.SANDBOX_COMPUTER_EGRESS,
): ComputerEgressSetting {
  if (value === undefined || value.trim() === "" || value === "open") return "open";
  if (value === "restricted" || value === "auto" || value === "proxy") return value;
  throw new Error(`Unsupported SANDBOX_COMPUTER_EGRESS value: ${value}`);
}

/**
 * DNS servers for computers, from SANDBOX_COMPUTER_DNS (comma-separated IP addresses).
 * Unset keeps Docker's default: a computer on its own network asks Docker's embedded
 * resolver, which forwards to the host's configured resolvers.
 * Docker 28+ forwards host DNS from the host namespace. Older Docker and explicit
 * container/daemon DNS forward from the computer network, where restricted egress
 * drops private resolvers. Servers set here replace that target.
 */
export function resolveComputerDns(value = process.env.SANDBOX_COMPUTER_DNS): string[] | undefined {
  const servers = (value ?? "")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length === 0) return undefined;
  const invalid = servers.find((server) => isIP(server) === 0);
  if (invalid) throw new Error(`Unsupported SANDBOX_COMPUTER_DNS server: ${invalid}`);
  return servers;
}

/** Whether a container's DNS servers are the ones configured (none configured: none set). */
export function computerDnsMatches(current: string[] | null | undefined, desired?: string[]) {
  const have = current ?? [];
  const want = desired ?? [];
  return have.length === want.length && have.every((server, index) => server === want[index]);
}

/** A host directory mounted into every computer (SANDBOX_COMPUTER_MOUNTS). */
export interface ComputerMount {
  source: string;
  target: string;
  readOnly: boolean;
  /** rslave: mounts made later under the source (a remounted network share) reach the computer. */
  propagation?: "rslave";
}

/** Container paths a mount may sit under: outside the home and every system directory. */
const MOUNT_TARGET_ROOTS = ["/mnt", "/media", "/srv"];
const MOUNT_OPTIONS = new Set(["ro", "rw", "rslave"]);
/**
 * Host paths no computer may see, nor any directory holding one: the Docker socket and runtime
 * state, kernel interfaces, host configuration and Docker's own storage.
 */
export const DENIED_MOUNT_SOURCES = [
  "/var/run",
  "/run",
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/boot",
  "/root",
  "/var/lib/docker",
];

// normalize keeps a trailing slash; Docker reports mounts without one.
function cleanMountPath(value: string) {
  return path.posix.normalize(value).replace(/(.)\/+$/, "$1");
}

function pathsOverlap(a: string, b: string) {
  const within = (child: string, parent: string) =>
    child === parent || parent === "/" || child.startsWith(`${parent}/`);
  return within(a, b) || within(b, a);
}

/**
 * Throws when a mount source is, holds, or sits inside a protected host path: the fixed
 * denylist plus the caller's own, such as the bot homes' data directory and the Docker socket.
 */
export function assertComputerMountSources(
  mounts: ComputerMount[],
  protectedPaths: readonly (string | undefined)[] = [],
) {
  const denied = [
    ...DENIED_MOUNT_SOURCES,
    ...protectedPaths
      .filter((entry): entry is string => Boolean(entry && path.posix.isAbsolute(entry)))
      .map(cleanMountPath),
  ];
  for (const mount of mounts) {
    const hit = denied.find((entry) => pathsOverlap(mount.source, entry));
    if (hit !== undefined) {
      throw new Error(
        `Unsupported SANDBOX_COMPUTER_MOUNTS source "${mount.source}": overlaps protected host path ${hit}`,
      );
    }
  }
}

/**
 * Host directories mounted into every computer in every Space, from SANDBOX_COMPUTER_MOUNTS:
 * comma-separated `source:target[:option...]` entries with options ro (default), rw and rslave.
 * Both paths are absolute without `..`. A target sits below /mnt, /media or /srv: inside
 * /home/rakazo Docker would create the mount point root-owned in the bot's home, which then
 * fails the home ownership check, and system directories are not the operator's to replace.
 */
export function resolveComputerMounts(
  value = process.env.SANDBOX_COMPUTER_MOUNTS,
  protectedPaths: readonly (string | undefined)[] = [],
): ComputerMount[] {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const mounts: ComputerMount[] = [];
  for (const entry of entries) {
    const [rawSource, rawTarget, ...options] = entry.split(":").map((part) => part.trim());
    const fail = (reason: string) =>
      new Error(`Unsupported SANDBOX_COMPUTER_MOUNTS entry "${entry}": ${reason}`);
    if (!rawSource || !rawTarget) throw fail("expected source:target[:ro|rw|rslave]");
    if (!path.posix.isAbsolute(rawSource) || !path.posix.isAbsolute(rawTarget))
      throw fail("source and target must be absolute paths");
    if ([rawSource, rawTarget].some((raw) => raw.split("/").includes("..")))
      throw fail("paths must not contain ..");
    const source = cleanMountPath(rawSource);
    const target = cleanMountPath(rawTarget);
    if (!MOUNT_TARGET_ROOTS.some((root) => target.startsWith(`${root}/`)))
      throw fail(`target must be below ${MOUNT_TARGET_ROOTS.join(", ")}`);
    const unknown = options.find((option) => !MOUNT_OPTIONS.has(option));
    if (unknown !== undefined) throw fail(`unknown option "${unknown}"`);
    if (options.includes("ro") && options.includes("rw")) throw fail("both ro and rw");
    // Mounts propagated in later keep their own flags, so read-only cannot be promised.
    if (options.includes("rslave") && !options.includes("rw")) throw fail("rslave requires rw");
    const overlap = mounts.find((other) => pathsOverlap(other.target, target));
    if (overlap) throw fail(`target overlaps ${overlap.target}`);
    mounts.push({
      source,
      target,
      readOnly: !options.includes("rw"),
      ...(options.includes("rslave") ? { propagation: "rslave" as const } : {}),
    });
  }
  assertComputerMountSources(mounts, protectedPaths);
  return mounts;
}

function computerMountSettings(mount: ComputerMount): Docker.MountSettings {
  return {
    Type: "bind",
    Source: mount.source,
    Target: mount.target,
    ReadOnly: mount.readOnly,
    ...(mount.propagation ? { BindOptions: { Propagation: mount.propagation } } : {}),
  } as Docker.MountSettings;
}

/**
 * Label holding each mount's configured source by target. Docker Desktop stores a bind source
 * as its own VM path when the container also mounts a volume, as every Compose computer's home
 * does, so the inspected Source cannot be compared with the setting.
 */
const MOUNT_SOURCES_LABEL = "rakazo.mountSources";

function mountSourcesLabel(mounts: ComputerMount[]) {
  return JSON.stringify(Object.fromEntries(mounts.map((mount) => [mount.target, mount.source])));
}

function labeledMountSources(labels: Record<string, string> | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(labels?.[MOUNT_SOURCES_LABEL] ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Whether a container carries exactly the configured host mounts. Mounts are fixed when a
 * container is created, so an added, changed or removed entry replaces the computer.
 */
export function computerMountsMatch(
  info: Pick<Docker.ContainerInspectInfo, "Config" | "HostConfig">,
  desired: ComputerMount[],
) {
  const binds = (info.HostConfig.Mounts ?? []).filter(
    (mount) => mount.Type === "bind" && mount.Target !== "/home/rakazo",
  );
  const sources = labeledMountSources(info.Config.Labels);
  return (
    binds.length === desired.length &&
    desired.every((want) =>
      binds.some(
        (have) =>
          sources[want.target] === want.source &&
          have.Target === want.target &&
          Boolean(have.ReadOnly) === want.readOnly &&
          (have.BindOptions?.Propagation ?? undefined) === want.propagation,
      ),
    )
  );
}

/**
 * Host bridge interface name for a computer network. Linux caps interface names
 * at 15 bytes (IFNAMSIZ), so "rakazo-c" gets a 7-hex-char suffix derived from the
 * same digest as the network name — deterministic across recreate, unique per bot.
 */
export function computerBridgeNameFor(botId: string) {
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 7);
  return `rakazo-c${hash}`;
}

/**
 * Owner label for this install's computer networks, which can share a Docker host
 * with other installs that name theirs the same way. It is derived from where the
 * computer homes live (see computerHomeStorage) and hashed to keep host paths out.
 */
export function computerNetworkOwnerFor(
  dataDir: string,
  info: Docker.ContainerInspectInfo | undefined,
) {
  const mount = info?.Mounts.find((entry) => entry.Destination === dataDir);
  const root =
    mount?.Type === "volume" ? `volume:${mount.Name}` : `path:${mount?.Source ?? dataDir}`;
  return createHash("sha256").update(root).digest("hex").slice(0, 32);
}

/**
 * Whether a network-create failure means this daemon may be unable to create
 * dual-stack networks: every capability error the daemon emits names IPv6 or
 * ip6tables ("could not find an available, non-overlapping IPv6 address pool…",
 * "Unable to enable IPv6 addresses on bridge…", "ip6tables is missing", "IPv6
 * global forwarding is disabled"), and the exact wording changes between
 * releases, so match broadly. A transient error that happens to name ip6tables
 * falls back too, but the fallback is bounded: a stop gives the network back
 * (reclaimComputerNetwork) and the next start creates it again, retrying IPv6.
 * Every other error surfaces, so a transient failure fails loudly and retries.
 */
export function isIpv6NetworkUnavailable(error: unknown): boolean {
  return /ipv6|ip6tables/i.test(String(error));
}

/**
 * IPv6 for computer networks, open egress only: Docker 27+ allocates each network
 * its own ULA /64 when no subnet is given and, with ip6tables on by default,
 * masquerades outbound traffic through the host's IPv6 address. A ULA source keeps
 * IPv4 preferred for dual-stack names (RFC 6724), so only IPv6-only destinations
 * move to IPv6. Restricted egress stays IPv4-only: the host ruleset and the
 * startup probe (egress-probe.ts) enforce and verify IPv4 only. Daemons that
 * cannot create the dual-stack network (Docker 26, Docker-in-Docker without
 * ip6_tables, IPv6 off in the kernel) get the same network without IPv6 from
 * the caller's fallback, so a computer start never fails on this.
 */
export function computerNetworkCreateOptions(
  botId: string,
  owner: string,
  egress: ComputerEgressMode = "open",
  ipv6 = true,
): Docker.NetworkCreateOptions {
  return {
    Name: computerNetworkNameFor(botId),
    Driver: "bridge",
    CheckDuplicate: true,
    ...(ipv6 && egress === "open" ? { EnableIPv6: true } : {}),
    Labels: { "rakazo.computerOwner": owner, "rakazo.botId": botId },
    ...(egress === "proxy" ? { Internal: true, EnableIPv6: false,
      Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" } } : {}),
    ...(egress === "restricted"
      ? { Options: { "com.docker.network.bridge.name": computerBridgeNameFor(botId) } }
      : {}),
  };
}

/**
 * Docker Engine API 1.48 added GwPriority. Older supported daemons must receive
 * the original connect payload, because their API cannot preserve this setting.
 */
export function screenPeerNetworkConnectOptions(
  containerId: string,
  apiVersion: string,
): Docker.NetworkConnectOptions {
  const version = /^(\d+)\.(\d+)$/.exec(apiVersion);
  const supportsGatewayPriority = Boolean(
    version && (Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= 48)),
  );
  if (!supportsGatewayPriority) return { Container: containerId };

  // @types/dockerode 4.0.1 predates the API field; the server accepts the
  // endpoint setting as part of the standard Engine API payload.
  const endpointConfig: Docker.EndpointSettings & { GwPriority: number } = { GwPriority: -1 };
  return { Container: containerId, EndpointConfig: endpointConfig };
}

export function hostComputerUser(uid = process.getuid?.(), gid = process.getgid?.()): string {
  if (uid === undefined || gid === undefined || uid === 0) return COMPUTER_USER;
  return `${uid}:${gid}`;
}

export function computerPortBindings(publishControlPort = false) {
  const ExposedPorts: Record<string, object> = {};
  const PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  const port = `${screenPorts(0).viewPort}/tcp`;
  ExposedPorts[port] = {};
  PortBindings[port] = [{ HostIp: "127.0.0.1", HostPort: "0" }];
  // Host-run Docker Desktop supervisors need an opt-in loopback mapping.
  // Otherwise control stays unpublished on the container network.
  if (publishControlPort) {
    ExposedPorts[`${COMPUTER_CONTROL_PORT}/tcp`] = {};
    PortBindings[`${COMPUTER_CONTROL_PORT}/tcp`] = [{ HostIp: "127.0.0.1", HostPort: "0" }];
  }
  return { ExposedPorts, PortBindings };
}

export function computerHomeStorage(
  serviceHomePath: string,
  dataDir: string,
  info: Docker.ContainerInspectInfo | undefined,
): { homePath: string; homeVolume?: { name: string; subpath: string } } {
  const relative = path.relative(dataDir, serviceHomePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("computer home must be inside the data directory");
  }
  const mount = info?.Mounts.find((entry) => entry.Destination === dataDir);
  if (mount?.Type === "volume") {
    if (!mount.Name) throw new Error("computer data volume has no name");
    return { homePath: serviceHomePath, homeVolume: { name: mount.Name, subpath: relative } };
  }
  return { homePath: mount?.Source ? path.join(mount.Source, relative) : serviceHomePath };
}

export function assertVolumeSubpathSupport(apiVersion: string) {
  const match = /^(\d+)\.(\d+)$/.exec(apiVersion);
  if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 45)) {
    throw new Error("Docker Engine 26+ (API 1.45+) is required for bot home volume subpaths");
  }
}

export function homeVolumeMatches(
  mounts: Docker.ContainerInspectInfo["HostConfig"]["Mounts"],
  volume: { name: string; subpath: string },
) {
  return (
    mounts?.some(
      (mount) =>
        mount.Target === "/home/rakazo" &&
        mount.Type === "volume" &&
        mount.Source === volume.name &&
        mount.VolumeOptions?.Subpath === volume.subpath &&
        !mount.ReadOnly,
    ) ?? false
  );
}

export interface ComputerCreateInput {
  name: string;
  image: string;
  botId: string;
  spaceId: string;
  homePath: string;
  homeVolume?: { name: string; subpath: string };
  user?: string;
  controlToken?: string;
  networkMode?: string;
  publishControlPort?: boolean;
  egressProxy?: string;
  dns?: string[];
  mounts?: ComputerMount[];
  locale?: ComputerLocale;
}

interface PointerInput {
  kind: "pointer";
  x: number;
  y: number;
  button?: "left" | "right";
  type: "move" | "down" | "up" | "click";
}

export type SandboxInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | PointerInput
  | { kind: "clipboard"; text: string };

export function containerCreateOptions(input: ComputerCreateInput) {
  const ports = computerPortBindings(input.publishControlPort);
  const extraMounts = (input.mounts ?? []).map(computerMountSettings);
  return {
    Image: input.image,
    name: input.name,
    User: input.user ?? COMPUTER_USER,
    Tty: true,
    Env: [
      ...Object.entries(COMPUTER_CACHE_ENV).map(([key, value]) => `${key}=${value}`),
      ...(input.egressProxy ? [
        `HTTP_PROXY=${input.egressProxy}`, `HTTPS_PROXY=${input.egressProxy}`,
        `http_proxy=${input.egressProxy}`, `https_proxy=${input.egressProxy}`,
        `RAKAZO_BROWSER_PROXY=${input.egressProxy}`,
        "NO_PROXY=localhost,127.0.0.1,::1", "no_proxy=localhost,127.0.0.1,::1",
      ] : []),
      "DISPLAY=:1",
      "HOME=/home/rakazo",
      "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NPM_CONFIG_PREFIX=/home/rakazo/.local",
      "PIP_USER=1",
      ...(input.controlToken ? [`RAKAZO_COMPUTER_CONTROL_TOKEN=${input.controlToken}`] : []),
      ...computerLocaleEnv(input.locale),
    ],
    Labels: {
      "rakazo.managed": "true",
      "rakazo.botId": input.botId,
      "rakazo.spaceId": input.spaceId,
      ...(input.mounts?.length ? { [MOUNT_SOURCES_LABEL]: mountSourcesLabel(input.mounts) } : {}),
    },
    ExposedPorts: ports.ExposedPorts,
    HostConfig: {
      ...(input.homeVolume
        ? {
            Binds: undefined,
            Mounts: [
              {
                Type: "volume" as const,
                Source: input.homeVolume.name,
                Target: "/home/rakazo",
                // Docker makes Labels and DriverConfig optional; dockerode's types do not.
                VolumeOptions: {
                  NoCopy: true,
                  Subpath: input.homeVolume.subpath,
                } as Docker.MountSettings["VolumeOptions"],
              },
              ...extraMounts,
            ],
          }
        : {
            Binds: [`${input.homePath}:/home/rakazo`],
            Mounts: extraMounts.length ? extraMounts : undefined,
          }),
      PortBindings: ports.PortBindings,
      ShmSize: 256 * 1024 * 1024,
      ...(input.egressProxy ? { Sysctls: { "net.ipv4.ip_forward": "0" } } : {}),
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ...computerResourceLimits(),
      ReadonlyPaths: ["/usr/share/novnc"],
      AutoRemove: false,
      NetworkMode: input.networkMode ?? "bridge",
      ...(input.dns ? { Dns: input.dns } : {}),
    },
    WorkingDir: "/home/rakazo",
  };
}

export function sanitizeIdentifier(botId: string) {
  const safe = botId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
  return safe || "box";
}

export function containerNameFor(botId: string) {
  return `rakazo-bot-${sanitizeIdentifier(botId)}`;
}

export function computerNetworkNameFor(botId: string) {
  // Keep distinct botIds on distinct networks even when sanitization collapses
  // characters (e.g. "a/b" and "ab"). Do not change containerNameFor — that
  // name must stay stable so an existing computer can resume.
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 32);
  return `rakazo-computer-${sanitizeIdentifier(botId).slice(0, 32)}-${hash}`;
}

/** Current and prior network names, for delete cleanup. */
export function computerNetworkNamesForCleanup(botId: string) {
  const safe = sanitizeIdentifier(botId);
  const digest = createHash("sha256").update(botId).digest("hex");
  return [
    computerNetworkNameFor(botId),
    `rakazo-computer-${safe}`,
    `rakazo-computer-${safe.slice(0, 32)}-${digest.slice(0, 8)}`,
  ];
}

/**
 * Legacy unsalted network names can collide across botIds. Only remove such a
 * network when no other bot's container is still attached.
 */
export function legacyNetworkOwnedSolelyBy(
  botId: string,
  attachedBotIds: Array<string | undefined>,
): boolean {
  return attachedBotIds.every((owner) => owner === botId);
}

export function screenUrlFor(hostPort: string, host = SCREEN_HOST) {
  return `http://${host}:${hostPort}/embed.html`;
}

export function screenUrlWithToken(screenUrl: string, token: string) {
  const url = new URL(screenUrl);
  url.searchParams.set("path", `websockify?token=${encodeURIComponent(token)}`);
  return url.toString();
}

/**
 * Decide which host:port clients (and readiness probes) should use.
 *
 * Per-bot NetworkMode isolation must not change this: a container always has a
 * docker-internal IP on its network, but browsers cannot load that 172.x
 * address. Compose modes that attach the supervisor/screen proxy to the bot
 * network may return the container IP; host-run supervisors use the published
 * loopback mapping.
 */
export function resolveScreenPublishTarget(input: {
  screenNetwork: ScreenNetworkMode;
  networkMode: string | null | undefined;
  networks: Record<string, { IPAddress?: string } | undefined> | null | undefined;
  hostPort: string | undefined;
  containerPort: string;
  screenHost?: string;
}): { host: string; port: string } | undefined {
  if (input.screenNetwork === "internal" || input.screenNetwork === "isolated") {
    const address = input.networkMode ? input.networks?.[input.networkMode]?.IPAddress : undefined;
    if (address) return { host: address, port: input.containerPort };
    return undefined;
  }
  if (input.hostPort) return { host: input.screenHost ?? SCREEN_HOST, port: input.hostPort };
  return undefined;
}

type ControlPortBindings =
  | Record<string, Array<{ HostIp?: string; HostPort?: string }> | null | undefined>
  | null
  | undefined;

function validHostPort(port: string | undefined): port is string {
  return !!port && /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
}

/** Resolve an assigned runtime port only when every control binding is loopback. */
export function publishedLoopbackControlHostPort(portBindings: ControlPortBindings) {
  const bindings = portBindings?.[`${COMPUTER_CONTROL_PORT}/tcp`];
  if (!bindings?.length || bindings.some((binding) => binding.HostIp !== "127.0.0.1")) {
    return undefined;
  }
  return bindings.find((binding) => validHostPort(binding.HostPort))?.HostPort;
}

/**
 * Reuse only containers whose configured control publication matches the setting.
 * Inspect HostConfig so stopped containers and Docker's automatic port allocation
 * (empty or zero HostPort) work before a runtime port has been assigned.
 */
export function controlPortPublicationMatches(
  portBindings: ControlPortBindings,
  publishControlPort: boolean,
): boolean {
  const bindings = portBindings?.[`${COMPUTER_CONTROL_PORT}/tcp`];
  if (!publishControlPort) return !bindings?.length;
  return (
    !!bindings?.length &&
    bindings.every(
      (binding) =>
        binding.HostIp === "127.0.0.1" &&
        (binding.HostPort === "" || binding.HostPort === "0" || validHostPort(binding.HostPort)),
    )
  );
}

/**
 * Resolve the computer control service. Prefer a published loopback HostPort
 * when provided; otherwise use the Docker network IP. When requirePublishedHostPort
 * is set, never fall back to the container IP (unreachable from Docker Desktop hosts).
 */
export function resolveComputerControlEndpoint(input: {
  token: string | undefined;
  networkMode: string | null | undefined;
  networks: Record<string, { IPAddress?: string } | undefined> | null | undefined;
  publishedHostPort?: string;
  requirePublishedHostPort?: boolean;
}): { url: string; token: string } | undefined {
  if (!input.token) return undefined;
  if (validHostPort(input.publishedHostPort)) {
    return {
      url: `http://127.0.0.1:${input.publishedHostPort}/v1/desktop`,
      token: input.token,
    };
  }
  if (input.requirePublishedHostPort) return undefined;
  const address =
    (input.networkMode ? input.networks?.[input.networkMode]?.IPAddress : undefined) ||
    Object.values(input.networks ?? {}).find((network) => network?.IPAddress)?.IPAddress;
  if (!address) return undefined;
  return { url: `http://${address}:${COMPUTER_CONTROL_PORT}/v1/desktop`, token: input.token };
}

export function xdotoolCommand(input: SandboxInput): string[] {
  if (input.kind === "key") {
    const key = mapKey(input.key);
    const mods = (input.modifiers ?? []).map(mapKey);
    const combo = [...mods, key].join("+");
    return ["xdotool", "key", "--clearmodifiers", combo];
  }
  if (input.kind === "pointer") {
    const btn = input.button === "right" ? "3" : "1";
    if (input.type === "move")
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y)];
    if (input.type === "down") {
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "mousedown", btn];
    }
    if (input.type === "up") return ["xdotool", "mouseup", btn];
    return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "click", btn];
  }
  return ["xdotool", "type", "--clearmodifiers", "--", input.text];
}

function mapKey(key: string) {
  const lower = key.toLowerCase();
  if (lower === "enter" || lower === "return") return "Return";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "space") return "space";
  if (lower === "tab") return "Tab";
  if (lower === "backspace") return "BackSpace";
  if (lower === "ctrl" || lower === "control") return "ctrl";
  if (lower === "alt") return "alt";
  if (lower === "shift") return "shift";
  if (lower === "meta" || lower === "cmd" || lower === "super") return "super";
  return key;
}
