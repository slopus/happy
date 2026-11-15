import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { computerNetworkCreateOptions, containerCreateOptions, resolveComputerEgressMode } from "./computer-spec.js";
import { assertProxyNetwork, connectPublicProxy, ISOLATED_GATEWAY, PUBLIC_EGRESS_PROXY } from "./proxy-egress.js";

describe("public proxy computer topology", () => {
  const network = { Internal: true, EnableIPv6: false, Options: { [ISOLATED_GATEWAY]: "isolated" },
    Labels: { "rakazo.computerOwner": "owner" }, Containers: {} } as unknown as Docker.NetworkInspectInfo;
  it("requires a named proxy mode and creates no direct host/internet route", () => {
    expect(resolveComputerEgressMode("proxy")).toBe("proxy");
    expect(computerNetworkCreateOptions("bot", "owner", "proxy")).toMatchObject({ Internal: true,
      EnableIPv6: false, Options: { [ISOLATED_GATEWAY]: "isolated" } });
    const guest = containerCreateOptions({ name: "test", image: "test", botId: "bot", spaceId: "space",
      homePath: "/data/homes/bot", egressProxy: PUBLIC_EGRESS_PROXY });
    expect(guest.Env).toContain(`HTTPS_PROXY=${PUBLIC_EGRESS_PROXY}`);
    expect(guest.Env).toContain(`RAKAZO_BROWSER_PROXY=${PUBLIC_EGRESS_PROXY}`);
    expect(guest.HostConfig.CapDrop).toEqual(["ALL"]);
  });
  it("rejects open, gateway-addressed, IPv6 or foreign networks", () => {
    expect(() => assertProxyNetwork(network, "owner")).not.toThrow();
    for (const override of [{ Internal: false }, { EnableIPv6: true }, { Options: {} }, { Labels: {} }]) {
      expect(() => assertProxyNetwork({ ...network, ...override } as Docker.NetworkInspectInfo, "owner")).toThrow(/isolated/);
    }
  });
  it("refuses missing proxy service or unsafe bridges before any attachment", async () => {
    const connect = vi.fn();
    const listContainers = vi.fn().mockResolvedValue([]);
    const raw = { listContainers, getNetwork: () => ({ inspect: async () => network, connect }) };
    const docker = raw as unknown as Docker;
    const supervisor = { Config: { Labels: { "com.docker.compose.project": "qa" } } } as unknown as Docker.ContainerInspectInfo;
    await expect(connectPublicProxy(docker, "guest", "owner", supervisor)).rejects.toThrow(/Exactly one/);
    expect(connect).not.toHaveBeenCalled();
    listContainers.mockResolvedValue([{ Id: "proxy" }]);
    await connectPublicProxy(docker, "guest", "owner", supervisor);
    expect(connect).toHaveBeenCalledWith({ Container: "proxy", EndpointConfig: { Aliases: ["paws-public-egress"] } });
    expect(listContainers).toHaveBeenLastCalledWith({ filters: { label: ["com.docker.compose.project=qa",
      "com.docker.compose.service=computer-egress", "paws.publicEgress=ipv4-http-v1"] } });
  });
});
