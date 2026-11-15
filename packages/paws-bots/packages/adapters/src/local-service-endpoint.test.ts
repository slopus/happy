import { describe, expect, it, vi } from "vitest";
import type { LocalServiceConnection } from "./local-service-endpoint.js";
import { LocalServiceHost, pinLocalServiceHost } from "./local-service-endpoint.js";
import type { ResolvedAddress } from "./network-address.js";

const baseUrl = "http://memory.example.test:8888";

describe("private memory DNS deadlines", () => {
  it("bounds DNS even for callers without an operation signal", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const resolveHostname = vi.fn(() => new Promise<ResolvedAddress[]>(() => {}));
    try {
      const pin = pinLocalServiceHost(baseUrl, { allowPrivateEndpoint: true, resolveHostname });
      const rejected = expect(pin).rejects.toThrow("Local mode requires");
      expect(resolveHostname).toHaveBeenCalledOnce();
      deadline.abort();
      await rejected;
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("does not discard a shared bounded pin when one caller is cancelled", async () => {
    let finish!: (addresses: ResolvedAddress[]) => void;
    const resolveHostname = vi.fn(
      () =>
        new Promise<ResolvedAddress[]>((resolve) => {
          finish = resolve;
        }),
    );
    const host = new LocalServiceHost(baseUrl, resolveHostname);
    const cancelled = new AbortController();
    const first = host.block(cancelled.signal);
    const second = host.block();
    cancelled.abort(new Error("caller stopped"));
    expect(await first).toBe("caller stopped");
    finish([{ address: "10.0.0.2", family: 4 }]);
    expect(await second).toBeNull();
    expect(await host.block()).toBeNull();
    expect(resolveHostname).toHaveBeenCalledOnce();
    expect(host.withPin<LocalServiceConnection>({ baseUrl }).pinnedAddresses).toEqual([
      { address: "10.0.0.2", family: 4 },
    ]);
  });
});
