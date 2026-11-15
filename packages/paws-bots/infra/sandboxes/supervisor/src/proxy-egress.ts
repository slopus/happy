import type Docker from "dockerode";

export const PUBLIC_EGRESS_PROXY = "http://paws-public-egress:3128";
export const ISOLATED_GATEWAY = "com.docker.network.bridge.gateway_mode_ipv4";

export function assertProxyNetwork(info: Docker.NetworkInspectInfo, owner: string) {
  if (!info.Internal || info.EnableIPv6 || info.Options?.[ISOLATED_GATEWAY] !== "isolated"
      || info.Labels?.["rakazo.computerOwner"] !== owner) {
    throw new Error("Computer network is not an owned IPv4-only isolated proxy network; stop and recreate it before continuing");
  }
}

// The proxy has no Docker socket, user data, capabilities or credentials. Its
// separate egress bridge is the only route out; guests have only an internal
// isolated bridge with no host address or default route.
export async function connectPublicProxy(docker: Docker, networkName: string, owner: string,
  supervisor: Docker.ContainerInspectInfo | undefined) {
  const project = supervisor?.Config.Labels?.["com.docker.compose.project"];
  if (!project) throw new Error("Proxy egress requires a Compose supervisor");
  const peers = await docker.listContainers({ filters: { label: [
    `com.docker.compose.project=${project}`, "com.docker.compose.service=computer-egress",
    "paws.publicEgress=ipv4-http-v1",
  ] } });
  if (peers.length !== 1) throw new Error("Exactly one running public egress proxy is required");
  const network = docker.getNetwork(networkName);
  const info = await network.inspect();
  assertProxyNetwork(info, owner);
  if (!info.Containers?.[peers[0]!.Id]) {
    await network.connect({ Container: peers[0]!.Id,
      EndpointConfig: { Aliases: ["paws-public-egress"] } });
  }
}
