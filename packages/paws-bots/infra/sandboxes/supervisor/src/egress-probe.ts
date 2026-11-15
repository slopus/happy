import { isIPv4 } from "node:net";
import type Docker from "dockerode";

/**
 * Restricted egress is enforced by host firewall rules the supervisor cannot see
 * (infra/compose/restrict-computer-egress.sh); without them a restricted computer
 * network is as open as any other. Before the first restricted computer starts, a
 * throwaway container on a `rakazo-c*` bridge tries TCP to that bridge's gateway,
 * which is the Docker host. The ruleset's INPUT drop makes every attempt time out;
 * a refused or accepted connection means the host answered, so the rules are missing.
 * The script inserts that INPUT drop after its DOCKER-USER destination drops, so it
 * stands in for the forwarded rules. The forwarded path is also checked directly
 * against the cloud metadata endpoint: where one exists it accepts connections unless
 * the drop is in place, and elsewhere nothing answers, so only a connection fails.
 * Explicit computer DNS is forwarded from the computer's network, where the ruleset drops
 * private resolvers, so at least one configured IPv4 server must answer a query from the
 * bridge (which has no IPv6). Any reply counts, so a resolver that only knows internal
 * names still passes.
 */
export const EGRESS_PROBE_NETWORK = "rakazo-egress-probe";
// Matches the ruleset's `rakazo-c+` interface pattern and Linux's 15-byte limit.
export const EGRESS_PROBE_BRIDGE = "rakazo-cprobe";
// 22 is open or allowed on most servers, 1 is closed nearly everywhere: either one
// answering is enough to show the host takes connections from computer bridges.
const PROBE_PORTS = [22, 1];
const PROBE_SECONDS_PER_PORT = 2;
const PROBE_DEADLINE_MS = 60_000;
const HOST_REACHABLE = 3;
const METADATA_ADDRESS = "169.254.169.254";
const METADATA_REACHABLE = 4;
const DNS_UNREACHABLE = 5;
// Each server gets two short tries, so one lost packet does not fail a start (18s for three).
const DNS_SECONDS = 3;

export const EGRESS_NOT_ENFORCED =
  "SANDBOX_COMPUTER_EGRESS=restricted is not enforced on this Docker host: run infra/compose/restrict-computer-egress.sh on the host, or set SANDBOX_COMPUTER_EGRESS=open (see docs/self-host-docker-computers.md)";

/**
 * A completed probe that shows the rules are missing, as opposed to a probe that could not finish
 * (a Docker error, an unexpected exit, the deadline). Only this one lets `auto` fall back to open.
 */
export class EgressNotEnforced extends Error {
  constructor(reason: string) {
    super(`${EGRESS_NOT_ENFORCED} (${reason})`);
  }
}

/**
 * Shell run in the probe container; exits 0 only when every gateway port timed out
 * and the metadata endpoint did not accept a connection, and some IPv4 `dns` server replied.
 */
export function egressProbeScript(gateway: string, dns: string[] = []) {
  const attempts = PROBE_PORTS.map(
    (port) =>
      `timeout ${PROBE_SECONDS_PER_PORT} bash -c 'exec 3<>/dev/tcp/${gateway}/${port}' 2>/dev/null; [ $? -eq 124 ] || exit ${HOST_REACHABLE}`,
  );
  const metadata = `timeout ${PROBE_SECONDS_PER_PORT} bash -c 'exec 3<>/dev/tcp/${METADATA_ADDRESS}/80' 2>/dev/null && exit ${METADATA_REACHABLE}`;
  // An A query for example.com with ID "RK"; a reply echoes the ID.
  // Docker's embedded resolver forwards to at most the first three servers.
  const queries = dns
    .slice(0, 3)
    .filter((server) => isIPv4(server))
    .map(
      (server) =>
        `for _ in 1 2; do timeout ${DNS_SECONDS} bash -c 'exec 3<>/dev/udp/$0/53 && printf "RK\\1\\0\\0\\1\\0\\0\\0\\0\\0\\0\\7example\\3com\\0\\0\\1\\0\\1" >&3 && [ "$(head -c2 <&3)" = RK ]' ${server} 2>/dev/null && exit 0; done`,
    );
  const last = queries.length > 0 ? `exit ${DNS_UNREACHABLE}` : "exit 0";
  return [...attempts, metadata, ...queries, last].join("\n");
}

export type EgressProbeVerdict =
  | "enforced"
  | "host-reachable"
  | "metadata-reachable"
  | "dns-unreachable"
  | "inconclusive";

export function egressProbeVerdict(statusCode: number | undefined): EgressProbeVerdict {
  if (statusCode === 0) return "enforced";
  if (statusCode === HOST_REACHABLE) return "host-reachable";
  if (statusCode === METADATA_REACHABLE) return "metadata-reachable";
  if (statusCode === DNS_UNREACHABLE) return "dns-unreachable";
  return "inconclusive";
}

function isAlreadyExists(error: unknown) {
  return /already exists/i.test(String(error));
}

/** Throws unless host and metadata traffic is blocked and any configured DNS server answers. */
export async function verifyRestrictedEgress(docker: Docker, image: string, dns?: string[]) {
  await docker
    .createNetwork({
      Name: EGRESS_PROBE_NETWORK,
      Driver: "bridge",
      CheckDuplicate: true,
      Labels: { "rakazo.egressProbe": "true" },
      Options: { "com.docker.network.bridge.name": EGRESS_PROBE_BRIDGE },
    })
    .catch((error) => {
      if (!isAlreadyExists(error)) throw error;
    });
  const network = docker.getNetwork(EGRESS_PROBE_NETWORK);
  let container: Docker.Container | undefined;
  try {
    const info = await network.inspect();
    if (info.Options?.["com.docker.network.bridge.name"] !== EGRESS_PROBE_BRIDGE) {
      throw new EgressNotEnforced("probe network lacks the named bridge");
    }
    const gateway = info.IPAM?.Config?.find((entry) => entry.Gateway?.includes("."))?.Gateway;
    if (!gateway) throw new EgressNotEnforced("probe network has no IPv4 gateway");
    container = await docker.createContainer({
      Image: image,
      Entrypoint: ["bash", "-c", egressProbeScript(gateway, dns)],
      Cmd: [],
      Labels: { "rakazo.egressProbe": "true" },
      HostConfig: {
        NetworkMode: EGRESS_PROBE_NETWORK,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        Memory: 64 * 1024 * 1024,
        PidsLimit: 32,
      },
    });
    await container.start();
    const result = await Promise.race([
      container.wait() as Promise<{ StatusCode?: number }>,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), PROBE_DEADLINE_MS).unref(),
      ),
    ]);
    const verdict = egressProbeVerdict(result?.StatusCode);
    if (verdict === "host-reachable") {
      throw new EgressNotEnforced("a computer bridge reached the host");
    }
    if (verdict === "metadata-reachable") {
      throw new EgressNotEnforced("a computer bridge reached the metadata endpoint");
    }
    if (verdict === "dns-unreachable") {
      throw new Error(
        "No SANDBOX_COMPUTER_DNS server answered from a restricted computer network; set servers reachable from there, such as public resolvers (see docs/self-host-docker-computers.md)",
      );
    }
    if (verdict === "inconclusive") {
      throw new Error(
        `${EGRESS_NOT_ENFORCED} (egress probe exited ${result?.StatusCode ?? "late"})`,
      );
    }
  } finally {
    await container?.remove({ force: true }).catch(() => undefined);
    await network.remove().catch(() => undefined);
  }
}
