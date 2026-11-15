import { describe, expect, it, vi } from "vitest";
import type { RakazoDesktop } from "../lib/desktop.js";
import { registerServiceWorker } from "./register.js";

function host(desktop?: RakazoDesktop) {
  const register = vi.fn(async () => ({}));
  const target = new EventTarget() as EventTarget & Parameters<typeof registerServiceWorker>[0];
  Object.assign(target, {
    navigator: { serviceWorker: { register } },
    rakazoDesktop: desktop,
  });
  return { target, register };
}

describe("registerServiceWorker", () => {
  it("registers after load in production browsers", () => {
    const { target, register } = host();
    registerServiceWorker(target, true);
    expect(register).not.toHaveBeenCalled();
    target.dispatchEvent(new Event("load"));
    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("stays off in dev and inside Electron", () => {
    const dev = host();
    registerServiceWorker(dev.target, false);
    dev.target.dispatchEvent(new Event("load"));
    expect(dev.register).not.toHaveBeenCalled();

    const electron = host({} as RakazoDesktop);
    registerServiceWorker(electron.target, true);
    electron.target.dispatchEvent(new Event("load"));
    expect(electron.register).not.toHaveBeenCalled();
  });
});
