import type { ProcessEvent } from "@rakazo/adapter-kit";
import type { HostComputerEnvironment, HostComputerRequest } from "./host-computer-protocol.js";
import type { HostScreenObservation } from "./host-screen.js";
import type { UserDevice, UserDeviceGateway } from "./user-device-protocol.js";

export const USER_DEVICE_EMULATOR_OUTPUT = "fixture-mac\n";

/**
 * Deterministic, offline stand-in for a connected desktop: every user has one, every command
 * prints USER_DEVICE_EMULATOR_OUTPUT, and every app shows one empty window. Records what it was
 * asked to run.
 */
export class UserDeviceEmulator implements UserDeviceGateway {
  readonly requests: Array<{ userId: string; request: HostComputerRequest }> = [];

  async connected(_userId: string): Promise<UserDevice> {
    return { deviceId: "emulated-device", name: "Fixture Mac", platform: "darwin" };
  }

  async pairedSince(_userId: string): Promise<Date> {
    return new Date(0);
  }

  async *request<T>(
    userId: string,
    request: HostComputerRequest,
    _signal: AbortSignal,
  ): AsyncIterable<T> {
    this.requests.push({ userId, request });
    if (request.method === "environment") {
      const environment: HostComputerEnvironment = {
        platform: "darwin",
        home: "/Users/fixture",
        shell: "/bin/zsh",
      };
      yield environment as T;
      return;
    }
    if (request.method === "execute") {
      const events: ProcessEvent[] = [
        { type: "stdout", data: USER_DEVICE_EMULATOR_OUTPUT },
        { type: "exit", code: 0 },
      ];
      for (const event of events) yield event as T;
      return;
    }
    if (request.method === "screenObserve" || request.method === "screenAct") {
      const observation: HostScreenObservation = {
        app: request.app,
        title: "Untitled",
        tree: '- [0] AXWindow "Untitled"\n  - [1] AXTextArea',
      };
      yield (
        request.method === "screenAct"
          ? { completed: request.actions.length, observation }
          : observation
      ) as T;
      return;
    }
    yield null as T;
  }
}
