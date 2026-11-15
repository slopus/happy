import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import Docker from "dockerode";
import { expect, it } from "vitest";
import { computerNetworkCreateOptions } from "./computer-spec.js";

/** Docker log frames (stream type, 4-byte length) concatenated as text. */
function demuxLogs(data: Buffer): string {
  let text = "";
  for (let offset = 0; offset + 8 <= data.length; ) {
    const length = data.readUInt32BE(offset + 4);
    text += data.subarray(offset + 8, offset + 8 + length).toString("utf8");
    offset += 8 + length;
  }
  return text;
}

/**
 * Opt-in check of a real daemon: an open-egress computer network as the supervisor
 * creates it gets an automatically allocated IPv6 subnet, and a computer on it
 * resolves and reaches an IPv6-only destination. With the opt-in set, an
 * unreachable daemon or a missing computer image fails the suite instead of
 * skipping it: a silent skip reads as a verified check. The reachability half
 * still skips on a host without outbound IPv6, after the subnet allocation is
 * verified. Needs the computer image (RAKAZO_COMPUTER_IMAGE or
 * rakazo/computer:local, which ships python3).
 */
it.skipIf(process.env.VERIFY_DOCKER_COMPUTER_IPV6 !== "1")(
  "gives a computer network IPv6 that reaches IPv6-only destinations",
  { timeout: 180_000 },
  async (ctx) => {
    const docker = new Docker();
    if (!(await docker.ping().catch(() => false))) {
      throw new Error(
        "VERIFY_DOCKER_COMPUTER_IPV6=1 but the Docker daemon is not reachable; the opt-in means this check runs",
      );
    }

    const botId = `ipv6-${randomUUID().slice(0, 8)}`;
    // Open egress: restricted networks stay IPv4-only.
    const options = computerNetworkCreateOptions(botId, "test-owner", "open");
    const network = await docker.createNetwork(options);
    let container: Docker.Container | undefined;
    try {
      const info = await network.inspect();
      const v6Subnet = info.IPAM?.Config?.find(
        (entry) => isIP(entry.Subnet?.split("/")[0] ?? "") === 6,
      )?.Subnet;
      expect(v6Subnet, "no IPv6 subnet allocated for the computer network").toBeDefined();

      // A ULA source with no host IPv6 route cannot reach anything, so the
      // reachability half only runs on hosts with a global IPv6 address.
      const hostHasGlobalV6 = Object.values(networkInterfaces())
        .flat()
        .some((entry) => String(entry?.family).includes("6") && /^[23]/.test(entry?.address ?? ""));
      if (!hostHasGlobalV6) ctx.skip();

      // Resolve and connect over IPv6 only; Docker's embedded resolver serves AAAA
      // once the network has IPv6, and the daemon masquerades through the host.
      const probe = `import socket
addrs = socket.getaddrinfo("ipv6.google.com", 80, socket.AF_INET6, socket.SOCK_STREAM)
socket.create_connection(addrs[0][4][:2], timeout=10).close()
print("V6_OK")`;
      try {
        container = await docker.createContainer({
          Image: process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local",
          Entrypoint: ["python3", "-c", probe],
          Cmd: [],
          Labels: { "rakazo.ipv6Probe": "true" },
          HostConfig: {
            NetworkMode: options.Name,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            ReadonlyRootfs: true,
            Memory: 128 * 1024 * 1024,
            PidsLimit: 64,
          },
        });
      } catch (error) {
        if (/404|No such image|manifest/i.test(String(error))) {
          throw new Error(
            `VERIFY_DOCKER_COMPUTER_IPV6=1 but the computer image is not available locally; build it or set RAKAZO_COMPUTER_IMAGE: ${String(error)}`,
          );
        }
        throw error;
      }
      await container.start();
      const result = await Promise.race([
        container.wait() as Promise<{ StatusCode?: number }>,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 60_000).unref()),
      ]);
      const logs = await container.logs({ stdout: true, stderr: true });
      expect(demuxLogs(logs)).toContain("V6_OK");
      expect(result?.StatusCode).toBe(0);
    } finally {
      await container?.remove({ force: true }).catch(() => undefined);
      await network.remove({ force: true }).catch(() => undefined);
    }
  },
);
