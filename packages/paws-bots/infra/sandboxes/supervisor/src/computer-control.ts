import { readBoundedJsonResponse } from "@rakazo/core";
import type Docker from "dockerode";
import type { z } from "zod";
import {
  publishedLoopbackControlHostPort,
  resolveComputerControlEndpoint,
} from "./computer-spec.js";
import { controlViaLoopback } from "./context.js";
import type { computerActionSchema } from "./supervisor-logic.js";
import {
  ComputerControlUnavailableError,
  computerControlTimeoutMs,
  containerActionSteps,
  isComputerControlUnavailable,
} from "./supervisor-logic.js";

export function computerControlEndpoint(info: Docker.ContainerInspectInfo) {
  const token = info.Config.Env?.find((value) =>
    value.startsWith("RAKAZO_COMPUTER_CONTROL_TOKEN="),
  )?.slice("RAKAZO_COMPUTER_CONTROL_TOKEN=".length);
  const publishedHostPort = controlViaLoopback
    ? publishedLoopbackControlHostPort(info.NetworkSettings?.Ports)
    : undefined;
  return resolveComputerControlEndpoint({
    token,
    networkMode: info.HostConfig.NetworkMode,
    networks: info.NetworkSettings?.Networks,
    publishedHostPort,
    requirePublishedHostPort: controlViaLoopback,
  });
}

export const MAX_COMPUTER_CONTROL_RESPONSE_BYTES = 16 * 1024 * 1024;

export async function controlDesktop(
  endpoint: { url: string; token: string },
  actions: Array<z.infer<typeof computerActionSchema>>,
  display: string,
  browserProfile: string,
  observe: boolean,
  settleMs: number,
) {
  const signal = AbortSignal.timeout(computerControlTimeoutMs(actions, settleMs));
  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      // The computer can replace its listener; keep requests on the inspected
      // computer's fixed endpoint instead of following it across sandbox networks.
      redirect: "error",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        steps: containerActionSteps(actions, display, browserProfile),
        display,
        observe,
        settleMs,
      }),
      signal,
    });
  } catch (error) {
    if (isComputerControlUnavailable(error)) {
      throw new ComputerControlUnavailableError(
        error instanceof Error ? error.message : "computer control unavailable",
      );
    }
    throw error;
  }
  const payload = await readBoundedJsonResponse<{
    completed?: unknown;
    observation?: unknown;
    error?: unknown;
  }>(response, MAX_COMPUTER_CONTROL_RESPONSE_BYTES, signal);
  if (!response.ok) throw new Error(String(payload.error ?? "computer control failed"));
  if (typeof payload.completed !== "number")
    throw new Error("computer control returned no completion count");
  return {
    completed: payload.completed,
    ...(payload.observation ? { observation: payload.observation } : {}),
  };
}
