import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import {
  EGRESS_PROBE_BRIDGE,
  EGRESS_PROBE_NETWORK,
  egressProbeScript,
  egressProbeVerdict,
  verifyRestrictedEgress,
} from "./egress-probe.js";

function fakeDocker({
  statusCode = 0,
  options = { "com.docker.network.bridge.name": EGRESS_PROBE_BRIDGE },
  gateway = "172.30.0.1",
  createNetworkError,
}: {
  statusCode?: number;
  options?: Record<string, string>;
  gateway?: string;
  createNetworkError?: Error;
} = {}) {
  const container = {
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue({ StatusCode: statusCode }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const network = {
    inspect: vi.fn().mockResolvedValue({
      Options: options,
      IPAM: { Config: [{ Subnet: "fd00::/64", Gateway: "fd00::1" }, { Gateway: gateway }] },
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const docker = {
    createNetwork: createNetworkError
      ? vi.fn().mockRejectedValue(createNetworkError)
      : vi.fn().mockResolvedValue({}),
    getNetwork: vi.fn().mockReturnValue(network),
    createContainer: vi.fn().mockResolvedValue(container),
  };
  return { docker: docker as unknown as Docker, raw: docker, container, network };
}

// Runs the probe's DNS lines against a UDP responder on 127.0.0.1; only the port differs from 53.
async function runDnsProbe(servers: string[], reply: (query: Buffer) => Buffer | undefined) {
  const responder = createSocket("udp4");
  responder.on("message", (query, peer) => {
    const answer = reply(query);
    if (answer) responder.send(answer, peer.port, peer.address);
  });
  await new Promise<void>((resolve) => responder.bind(0, "127.0.0.1", resolve));
  try {
    const { port } = responder.address() as AddressInfo;
    const lines = egressProbeScript("192.0.2.1", servers).split("\n");
    const dns = lines.slice(lines.findIndex((line) => line.includes("/dev/udp/")));
    const script = dns.join("\n").replaceAll("/dev/udp/$0/53 ", `/dev/udp/$0/${port} `);
    expect(script).toContain(`/dev/udp/$0/${port} `);
    expect(script).not.toContain("/53 ");
    return await new Promise<number | null>((resolve) =>
      spawn("bash", ["-c", script], { stdio: "ignore" }).on("exit", resolve),
    );
  } finally {
    responder.close();
  }
}

// A recursive A query for example.com, as a resolver would parse it.
const QUESTION = Buffer.from(
  "\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01",
  "latin1",
);

function answer(rcode: number) {
  return (query: Buffer) =>
    query.subarray(2).equals(QUESTION)
      ? Buffer.concat([query.subarray(0, 2), Buffer.from([0x81, 0x80 | rcode]), query.subarray(4)])
      : undefined;
}

describe("egress probe", () => {
  it("classifies probe exit codes", () => {
    expect(egressProbeVerdict(0)).toBe("enforced");
    expect(egressProbeVerdict(3)).toBe("host-reachable");
    expect(egressProbeVerdict(4)).toBe("metadata-reachable");
    expect(egressProbeVerdict(5)).toBe("dns-unreachable");
    expect(egressProbeVerdict(1)).toBe("inconclusive");
    expect(egressProbeVerdict(undefined)).toBe("inconclusive");
  });

  it("passes only when every connection to the gateway times out", () => {
    const script = egressProbeScript("172.30.0.1");
    expect(script).toContain("/dev/tcp/172.30.0.1/22");
    expect(script).toContain("/dev/tcp/172.30.0.1/1");
    expect(script).toContain("[ $? -eq 124 ] || exit 3");
    // Only an accepted metadata connection fails: hosts without one time out or are unreachable.
    expect(script).toContain("/dev/tcp/169.254.169.254/80' 2>/dev/null && exit 4");
    expect(script).not.toContain("/dev/udp");
    expect(script.trim().endsWith("exit 0")).toBe(true);
  });

  it("probes from a named rakazo-c bridge and cleans up", async () => {
    const { docker, raw, container, network } = fakeDocker();
    await expect(verifyRestrictedEgress(docker, "computer:test")).resolves.toBeUndefined();
    expect(EGRESS_PROBE_BRIDGE).toMatch(/^rakazo-c/);
    expect(EGRESS_PROBE_BRIDGE.length).toBeLessThanOrEqual(15);
    expect(raw.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        Name: EGRESS_PROBE_NETWORK,
        Options: { "com.docker.network.bridge.name": EGRESS_PROBE_BRIDGE },
      }),
    );
    expect(raw.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: "computer:test",
        Entrypoint: ["bash", "-c", egressProbeScript("172.30.0.1")],
        HostConfig: expect.objectContaining({
          NetworkMode: EGRESS_PROBE_NETWORK,
          CapDrop: ["ALL"],
        }),
      }),
    );
    expect(container.remove).toHaveBeenCalledWith({ force: true });
    expect(network.remove).toHaveBeenCalledOnce();
  });

  it("checks the computers' configured IPv4 DNS servers", async () => {
    const { docker, raw } = fakeDocker();
    await verifyRestrictedEgress(docker, "computer:test", ["2606:4700::1111", "1.1.1.1"]);
    const script: string = raw.createContainer.mock.calls[0]?.[0].Entrypoint[2];
    expect(script).toBe(egressProbeScript("172.30.0.1", ["1.1.1.1"]));
    expect(script).toMatch(/' 1\.1\.1\.1 2>\/dev\/null && exit 0; done\nexit 5$/);
    expect(egressProbeScript("172.30.0.1", ["2606:4700::1111"])).toBe(
      egressProbeScript("172.30.0.1"),
    );
    // Docker forwards to the first three servers only.
    const four = egressProbeScript("172.30.0.1", [
      "2606:4700::1111",
      "1.1.1.1",
      "1.0.0.1",
      "9.9.9.9",
    ]);
    expect(four).toContain("' 1.0.0.1 2>/dev/null");
    expect(four).not.toContain("9.9.9.9");
  });

  describe.skipIf(process.platform !== "linux")("DNS check", () => {
    it.each([
      ["NOERROR", 0],
      ["NXDOMAIN", 3],
      ["REFUSED", 5],
    ])("passes when a server replies %s", async (_name, rcode) => {
      expect(await runDnsProbe(["127.0.0.1"], answer(rcode))).toBe(0);
    });

    it("passes when a later server replies after an unreachable one", async () => {
      expect(await runDnsProbe(["127.0.0.2", "127.0.0.1"], answer(0))).toBe(0);
    });

    it("fails a reply to another query", async () => {
      const reply = (query: Buffer) =>
        answer(0)(Buffer.concat([Buffer.from("XX"), query.subarray(2)]));
      expect(await runDnsProbe(["127.0.0.1"], reply)).toBe(5);
    });

    it("passes when a server answers a resent query after losing the first", {
      timeout: 15_000,
    }, async () => {
      let received = 0;
      const reply = (query: Buffer) => (received++ === 0 ? undefined : answer(0)(query));
      expect(await runDnsProbe(["127.0.0.1"], reply)).toBe(0);
      expect(received).toBe(2);
    });

    it("fails when no server replies", { timeout: 15_000 }, async () => {
      expect(await runDnsProbe(["127.0.0.1"], () => undefined)).toBe(5);
    });
  });

  it("refuses failed DNS without falling back to open egress", async () => {
    const { docker, container, network } = fakeDocker({ statusCode: 5 });
    const error = await verifyRestrictedEgress(docker, "computer:test", ["1.1.1.1"]).catch(
      (error) => error,
    );
    expect(error.constructor).toBe(Error);
    expect(error.message).toBe(
      "No SANDBOX_COMPUTER_DNS server answered from a restricted computer network; set servers reachable from there, such as public resolvers (see docs/self-host-docker-computers.md)",
    );
    expect(container.remove).toHaveBeenCalledWith({ force: true });
    expect(network.remove).toHaveBeenCalledOnce();
  });

  it("reuses a probe network left by an earlier run", async () => {
    const { docker } = fakeDocker({ createNetworkError: new Error("network already exists") });
    await expect(verifyRestrictedEgress(docker, "computer:test")).resolves.toBeUndefined();
  });

  it.each([
    ["the host answered", { statusCode: 3 }, /reached the host/],
    ["the metadata endpoint answered", { statusCode: 4 }, /reached the metadata endpoint/],
    ["the probe failed", { statusCode: 125 }, /probe exited 125/],
    ["the bridge is unnamed", { options: {} }, /lacks the named bridge/],
  ])("refuses when %s", async (_label, input, detail) => {
    const { docker, network } = fakeDocker(input);
    const result = verifyRestrictedEgress(docker, "computer:test");
    await expect(result).rejects.toThrow(/restrict-computer-egress\.sh/);
    await expect(result).rejects.toThrow(detail);
    expect(network.remove).toHaveBeenCalledOnce();
  });
});
