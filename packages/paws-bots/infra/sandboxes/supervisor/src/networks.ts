import { getLogger } from "@rakazo/logging";
import type Docker from "dockerode";
import {
  computerBridgeNameFor,
  computerNetworkCreateOptions,
  computerNetworkNameFor,
  computerNetworkNamesForCleanup,
  computerNetworkOwnerFor,
  containerNameFor,
  isIpv6NetworkUnavailable,
  legacyNetworkOwnedSolelyBy,
  screenPeerNetworkConnectOptions,
} from "./computer-spec.js";
import {
  dataDir,
  docker,
  inspectSupervisorContainer,
  screenNetworkMode,
  supervisorInfo,
} from "./context.js";
import { computerEgressMode } from "./egress.js";
import { withBotLifecycleLock } from "./locks.js";
import { connectPublicProxy } from "./proxy-egress.js";

let dockerApiVersion: string | undefined;
// Control and observe address the computer on its own network. A recreated
// supervisor container comes back on the Compose network only, and screen setup
// (publishedScreenUrl) may never run again for an already-running computer, so
// rejoin here before every use. Idempotent: one network inspect when attached.
export async function rejoinComputerNetwork(info: Docker.ContainerInspectInfo) {
  if (screenNetworkMode !== "isolated") return;
  const runtime = supervisorInfo ?? (await inspectSupervisorContainer());
  const networkName = info.HostConfig.NetworkMode;
  if (runtime && networkName) await connectComposeScreenPeers(networkName, runtime);
}

// Each bot's computer gets its own Docker network so containers cannot reach
// one another (Docker's default "bridge" network allows any container to
// dial any other container's exposed ports, which would let one bot's
// computer reach another bot's desktop/VNC endpoint with no authentication).
export function computerNetworkName(botId: string, info: Docker.ContainerInspectInfo | undefined) {
  if (screenNetworkMode === "internal") {
    // The supervisor itself runs in this shared network in that topology and
    // needs to address child containers by their in-network IP, so children
    // stay on the supervisor's network rather than an isolated one.
    return info ? Object.keys(info.NetworkSettings.Networks)[0] : undefined;
  }
  if (screenNetworkMode === "isolated" && !info) {
    throw new Error("isolated Compose screens require a containerized supervisor");
  }
  return computerNetworkNameFor(botId);
}

async function composeScreenPeerIds(info: Docker.ContainerInspectInfo) {
  const peerIds = new Set([info.Id]);
  const project = info.Config.Labels?.["com.docker.compose.project"];
  if (project) {
    const webContainers = await docker.listContainers({
      all: true,
      filters: {
        label: [`com.docker.compose.project=${project}`, "com.docker.compose.service=web"],
      },
    });
    for (const container of webContainers) peerIds.add(container.Id);
  }
  if (project && computerEgressMode === "proxy") {
    const proxies = await docker.listContainers({ all: true, filters: { label: [
      `com.docker.compose.project=${project}`, "com.docker.compose.service=computer-egress",
    ] } });
    for (const proxy of proxies) peerIds.add(proxy.Id);
  }
  return peerIds;
}

export async function connectComposeScreenPeers(
  networkName: string,
  info: Docker.ContainerInspectInfo,
) {
  const peerIds = await composeScreenPeerIds(info);
  const network = docker.getNetwork(networkName);
  const networkInfo = await network.inspect();
  const connectedIds = new Set(Object.keys(networkInfo.Containers ?? {}));
  const missingPeerIds = [...peerIds].filter((containerId) => !connectedIds.has(containerId));
  if (computerEgressMode === "proxy") {
    const owner = computerNetworkOwnerFor(dataDir, info);
    await connectPublicProxy(docker, networkName, owner, info);
  }
  if (missingPeerIds.length === 0) return;
  let apiVersion = dockerApiVersion;
  if (!apiVersion) {
    try {
      apiVersion = (await docker.version()).ApiVersion;
      dockerApiVersion = apiVersion;
    } catch {
      // Version discovery is optional: preserve legacy connectivity and retry
      // discovery on a later join rather than caching a transient failure.
      apiVersion = "";
    }
  }
  await Promise.all(
    missingPeerIds.map((containerId) =>
      network.connect(screenPeerNetworkConnectOptions(containerId, apiVersion)).catch((error) => {
        if (!/already exists|already connected/i.test(String(error))) throw error;
      }),
    ),
  );
}

// A missing network is undefined; transient inspect failures must surface
// instead of force-replacing a healthy computer.
export async function inspectNetworkIfPresent(name: string) {
  return docker
    .getNetwork(name)
    .inspect()
    .catch((error) => {
      const status = (error as { statusCode?: number })?.statusCode;
      if (status === 404 || /no such network|not found/i.test(String(error))) return undefined;
      throw error;
    });
}

// Rejoins a stopped computer to its network, recreating the network if a stop
// gave it back. Docker errors surface like any provision failure, so a brief
// outage cannot cost the computer its container. False means Docker refuses to
// attach this container, and the caller replaces it instead.
export async function reconnectBotComputer(
  container: Docker.Container,
  botId: string,
  owner: string,
  staleEndpoint: boolean,
) {
  await ensureBotNetwork(botId, owner);
  const network = docker.getNetwork(computerNetworkNameFor(botId));
  if (staleEndpoint) {
    await network.disconnect({ Container: container.id, Force: true }).catch((error) => {
      // Already gone is fine. Anything else fails the provision: a stale endpoint
      // left in place would make the connect below look unattachable.
      const status = (error as { statusCode?: number })?.statusCode;
      if (status !== 404 && !/not connected|not found|no such/i.test(String(error))) throw error;
    });
  }
  return network.connect({ Container: container.id }).then(
    () => true,
    (error) => {
      // A leftover or conflicting endpoint, which a retry would not clear.
      const status = (error as { statusCode?: number })?.statusCode;
      const unattachable =
        status === 404 ||
        status === 409 ||
        /not found|no such|already exists|already connected/i.test(String(error));
      if (!unattachable) throw error;
      getLogger().error("computer network reconnect failed", error);
      return false;
    },
  );
}

/**
 * Startup cleanup for networks whose computer is gone, e.g. removed by hand.
 * Other installs can share this Docker host and name their networks the same
 * way, so only networks carrying this install's owner label are considered;
 * unlabeled networks from older supervisors are left alone.
 */
export async function reclaimIdleComputerNetworks() {
  if (screenNetworkMode === "internal") return;
  const runtime = await inspectSupervisorContainer();
  const owner = computerNetworkOwnerFor(dataDir, runtime);
  const networks = await docker.listNetworks({
    filters: { label: [`rakazo.computerOwner=${owner}`] },
  });
  for (const { Name, Labels } of networks) {
    const botId = Labels?.["rakazo.botId"];
    if (!botId || Name !== computerNetworkNameFor(botId)) continue;
    await withBotLifecycleLock(botId, () => removeUnusedComputerNetwork(Name)).catch((error) => {
      getLogger().error("computer network reclaim failed", error);
    });
  }
}

// The supervisor and Compose web proxy join isolated computer networks to reach
// screens and rejoin lazily, so they do not keep a network in use.
async function screenPeerIds() {
  const runtime = screenNetworkMode === "isolated" ? await inspectSupervisorContainer() : undefined;
  return runtime ? await composeScreenPeerIds(runtime) : new Set<string>();
}

// Removes a computer network used by nothing but screen peers and, when given,
// its stopped computer. Network inspect lists only running containers, so the
// users are listed by network: a stopped container left referencing a removed
// network cannot start again. Each user is disconnected first, and a failed
// disconnect keeps the network for the same reason.
export async function removeUnusedComputerNetwork(name: string, computerId?: string) {
  const users = await docker.listContainers({ all: true, filters: { network: [name] } });
  const peerIds = await screenPeerIds();
  if (users.some((user) => user.Id !== computerId && !peerIds.has(user.Id))) return;
  const network = docker.getNetwork(name);
  // The computer goes first: it must be able to rejoin when it resumes.
  users.sort((a, b) => Number(b.Id === computerId) - Number(a.Id === computerId));
  for (const user of users) {
    await network.disconnect({ Container: user.Id });
  }
  // Docker refuses while an endpoint is active, e.g. a peer that rejoined meanwhile.
  await network.remove().catch((error) => {
    if (!/active endpoints/i.test(String(error))) throw error;
  });
}

// Every computer network holds a subnet from Docker's address pools, which run
// out after a few dozen networks, so a stopped computer gives its network back.
// It is reconnected when it resumes, and screen peers rejoin lazily.
export async function reclaimComputerNetwork(container: Docker.Container, botId: string) {
  // The bot lock keeps a provision from resuming the computer meanwhile.
  await withBotLifecycleLock(botId, async () => {
    const name = computerNetworkNameFor(botId);
    const computer = await container.inspect();
    if (computer.State.Running || !(await inspectNetworkIfPresent(name))) return;
    await removeUnusedComputerNetwork(name, computer.Id);
  });
}

export async function ensureBotNetwork(botId: string, owner: string) {
  if (computerEgressMode === "proxy") {
    let created: Docker.Network | undefined;
    try {
      created = await docker.createNetwork(computerNetworkCreateOptions(botId, owner, "proxy"));
    } catch (error) {
      if (!/already exists/i.test(String(error))) throw error;
    }
    try {
      await connectPublicProxy(docker, computerNetworkNameFor(botId), owner, await inspectSupervisorContainer());
    } catch (error) {
      if (created) await removeUnusedComputerNetwork(computerNetworkNameFor(botId)).catch(() => undefined);
      throw error;
    }
    return created;
  }
  const ensure = (ipv6: boolean) =>
    docker
      .createNetwork(computerNetworkCreateOptions(botId, owner, computerEgressMode, ipv6))
      .catch(async (error) => {
        // Existing networks and concurrent provision requests are both safe.
        if (!/already exists/i.test(String(error))) throw error;
        if (computerEgressMode === "restricted") {
          await rekeyRestrictedBotNetwork(computerNetworkNameFor(botId), botId, owner);
        }
      });
  return ensure(true).catch(async (error) => {
    // A daemon that cannot create the dual-stack network (Docker 26, Docker-in-Docker
    // without ip6_tables, IPv6 off in the kernel) still gets a plain IPv4 one.
    // Transient errors are left to surface, so the next start retries with IPv6.
    if (!isIpv6NetworkUnavailable(error)) throw error;
    getLogger().warn("computer network without IPv6, using IPv4 only", {
      error: String(error),
    });
    // The fallback's network handle must reach the caller: the provision rollback
    // removes the network it created when a later step fails.
    return ensure(false);
  });
}

// A network created before SANDBOX_COMPUTER_EGRESS=restricted has a generic br-*
// bridge the host ruleset does not match. Recreate it with the named bridge: the
// callers attach the computer afterwards (the create path replaces it, a resume
// reconnects it), and supervisor/web screen peers rejoin lazily via
// connectComposeScreenPeers.
async function rekeyRestrictedBotNetwork(name: string, botId: string, owner: string) {
  const expectedBridge = computerBridgeNameFor(botId);
  const inspect = () =>
    docker
      .getNetwork(name)
      .inspect()
      .catch(() => undefined);
  const hasNamedBridge = (info: Docker.NetworkInspectInfo | undefined) =>
    info?.Options?.["com.docker.network.bridge.name"] === expectedBridge;
  const info = await inspect();
  if (info && !hasNamedBridge(info)) {
    const network = docker.getNetwork(name);
    const containerIds = Object.keys(info.Containers ?? {});
    for (const containerId of containerIds) {
      await network.disconnect({ Container: containerId, Force: true }).catch(() => undefined);
    }
    const removed = await network.remove().then(
      () => true,
      () => false,
    );
    // Fail closed. This bridge is outside the host ruleset, so reconnecting
    // would restore access to the host, private networks, and metadata.
    // Stop this bot's containers in case disconnect left one running there.
    if (!removed) {
      await stopBotContainers(containerIds, botId);
      throw new Error(`cannot restrict egress: failed to replace unrestricted network ${name}`);
    }
  }
  if (!info || !hasNamedBridge(info)) {
    // Restricted networks are IPv4-only (see computerNetworkCreateOptions), so
    // no IPv6 fallback is needed here.
    await docker
      .createNetwork(computerNetworkCreateOptions(botId, owner, "restricted"))
      .catch((error) => {
        if (!/already exists/i.test(String(error))) throw error;
      });
  }
  if (!hasNamedBridge(await inspect())) {
    throw new Error(`cannot restrict egress: network ${name} is missing the named bridge`);
  }
}

async function stopContainer(container: Docker.Container) {
  await container.stop({ t: 1 }).catch(async () => {
    await container.kill().catch(() => undefined);
  });
}

async function stopBotContainers(containerIds: string[], botId: string) {
  const stoppedIds = new Set<string>();
  await Promise.all(
    containerIds.map(async (containerId) => {
      const container = docker.getContainer(containerId);
      const inspected = await container.inspect().catch(() => undefined);
      // A failed inspect is not proof this endpoint belongs to someone else.
      // Only a successful inspect of a different bot may skip the stop.
      if (inspected && inspected.Config.Labels?.["rakazo.botId"] !== botId) return;
      if (!inspected) return;
      await stopContainer(container);
      stoppedIds.add(containerId);
      if (inspected.Id) stoppedIds.add(inspected.Id);
    }),
  );
  // The computer's name does not depend on reading the endpoint. Stop it even
  // when inspect failed, so a failed disconnect cannot leave it running.
  const named = docker.getContainer(containerNameFor(botId));
  const namedInfo = await named.inspect().catch(() => undefined);
  if (namedInfo?.Id && stoppedIds.has(namedInfo.Id)) return;
  await stopContainer(named);
}

export async function removeBotNetwork(botId: string) {
  const currentName = computerNetworkNameFor(botId);
  for (const name of computerNetworkNamesForCleanup(botId)) {
    const network = docker.getNetwork(name);
    const info = await network.inspect().catch(() => undefined);
    if (!info) continue;
    if (name === currentName) {
      // Stopped screen peers must be disconnected too, or they cannot start again.
      await removeUnusedComputerNetwork(name).catch((error) => {
        getLogger().error("computer network reclaim failed", error);
      });
      continue;
    }
    const owners: Array<string | undefined> = [];
    for (const containerId of Object.keys(info.Containers ?? {})) {
      const labels =
        (
          await docker
            .getContainer(containerId)
            .inspect()
            .catch(() => undefined)
        )?.Config.Labels ?? {};
      const owner = labels["rakazo.botId"];
      owners.push(owner);
      if (owner === botId) {
        await network.disconnect({ Container: containerId, Force: true }).catch(() => undefined);
      }
    }
    if (!legacyNetworkOwnedSolelyBy(botId, owners)) continue;
    const remaining = await network.inspect().catch(() => undefined);
    for (const containerId of Object.keys(remaining?.Containers ?? {})) {
      await network.disconnect({ Container: containerId, Force: true }).catch(() => undefined);
    }
    await network.remove().catch(() => undefined);
  }
}
