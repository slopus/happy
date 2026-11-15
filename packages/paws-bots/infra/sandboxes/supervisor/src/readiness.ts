import http from "node:http";
import type Docker from "dockerode";
import { resolveScreenPublishTarget, SCREEN_HOST, screenUrlFor } from "./computer-spec.js";
import { inspectSupervisorContainer, screenNetworkMode, supervisorInfo } from "./context.js";
import { connectComposeScreenPeers } from "./networks.js";

const SCREEN_READY_TIMEOUT_MS = 45_000;

// Docker publishes the port mapping before websockify inside the container is
// serving, and a bare TCP connect can succeed before it is too. Polling the same
// embed.html the iframe loads keeps the frontend from hitting "socket hang up".
export async function waitForScreenReady(host: string, port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    const ready = await new Promise<boolean>((resolve) => {
      const req = http.get({ host, port, path: "/embed.html", timeout: 1_500 }, (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      });
      req.once("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.once("error", () => resolve(false));
    });
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  return false;
}

export async function publishedScreenUrl(
  container: Docker.Container,
  initialInfo?: Docker.ContainerInspectInfo,
  containerPort = "6080",
) {
  for (let i = 0; i < 30; i += 1) {
    const info = i === 0 && initialInfo ? initialInfo : await container.inspect();
    if (screenNetworkMode === "isolated") {
      const runtime = supervisorInfo ?? (await inspectSupervisorContainer());
      const networkName = info.HostConfig.NetworkMode;
      if (runtime && networkName) await connectComposeScreenPeers(networkName, runtime);
    }
    const target = resolveScreenPublishTarget({
      screenNetwork: screenNetworkMode,
      networkMode: info.HostConfig.NetworkMode,
      networks: info.NetworkSettings?.Networks,
      hostPort: info.NetworkSettings?.Ports?.[`${containerPort}/tcp`]?.[0]?.HostPort,
      containerPort,
      screenHost: SCREEN_HOST,
    });
    if (target) {
      const ready = await waitForScreenReady(
        target.host,
        Number(target.port),
        SCREEN_READY_TIMEOUT_MS,
      );
      if (!ready) throw new Error("computer screen did not become ready in time");
      return screenUrlFor(target.port, target.host);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("computer screen port was not published");
}
