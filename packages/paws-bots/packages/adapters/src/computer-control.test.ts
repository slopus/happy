import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  clearInactiveUserComputerControl,
  expireComputerControl,
  hasActiveComputerControl,
  revokeScreenControl,
} from "./computer-control.js";

describe("computer control leases", () => {
  it("requires every persisted lease boundary to authorize control", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const active = {
      controlHolder: "user",
      controlLeaseId: "lease-1",
      controlLeaseExpiresAt: new Date(now.getTime() + 1),
    };
    expect(hasActiveComputerControl(active, now)).toBe(true);
    expect(hasActiveComputerControl({ ...active, controlHolder: "none" }, now)).toBe(false);
    expect(hasActiveComputerControl({ ...active, controlLeaseId: null }, now)).toBe(false);
    expect(hasActiveComputerControl({ ...active, controlLeaseExpiresAt: now }, now)).toBe(false);
  });

  it("reschedules an early delivery without revoking control", async () => {
    const expiresAt = new Date("2026-01-01T00:00:01.000Z");
    const harness = controlHarness({ controlLeaseExpiresAt: expiresAt });

    await expect(
      expireComputerControl(
        harness.deps,
        "computer-id",
        "lease-1",
        new Date("2026-01-01T00:00:00.000Z"),
      ),
    ).resolves.toBe(false);

    expect(harness.enqueue).toHaveBeenCalledWith({
      name: "computer.control-expire",
      payload: { computerId: "computer-id", leaseId: "lease-1" },
      availableAt: expiresAt,
      replaceKey: "computer.control-expire:computer-id:lease-1",
    });
    expect(harness.setScreenControl).not.toHaveBeenCalled();
  });

  it("denies control, revokes the stream, and clears the lease without resuming a run", async () => {
    const harness = controlHarness();

    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(true);

    expect(harness.prisma.computer.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "computer-id", controlLeaseId: "lease-1" },
      data: { controlLeaseExpiresAt: new Date(0) },
    });
    expect(harness.setScreenControl).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer" }),
      false,
      expect.objectContaining({ operationId: "computer.control-expire" }),
      "lease-1",
    );
    expect(harness.events.releaseUserControl).toHaveBeenCalledWith({
      spaceId: "workspace",
      computerId: "computer-id",
      botId: "bot",
      leaseId: "lease-1",
      reason: "expired",
    });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a lease a heartbeat renewed after the expiry job read it", async () => {
    const lapsed = new Date("2026-01-01T00:00:00.000Z");
    const renewed = new Date("2026-01-01T00:01:30.000Z");
    const harness = controlHarness({ controlLeaseExpiresAt: lapsed });
    harness.prisma.computer.findUnique
      .mockResolvedValueOnce(harness.computer)
      .mockResolvedValueOnce({ ...harness.computer, controlLeaseExpiresAt: renewed });
    harness.prisma.computer.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      expireComputerControl(harness.deps, "computer-id", "lease-1", lapsed),
    ).resolves.toBe(false);

    // The claim itself requires the lease still to be lapsed, so a renewal in between wins.
    expect(harness.prisma.computer.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        controlLeaseId: "lease-1",
        OR: [{ controlLeaseExpiresAt: null }, { controlLeaseExpiresAt: { lte: lapsed } }],
      },
    });
    expect(harness.setScreenControl).not.toHaveBeenCalled();
    expect(harness.events.releaseUserControl).not.toHaveBeenCalled();
    expect(harness.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "computer.control-expire", availableAt: renewed }),
    );
  });

  it("keeps the denied lease retryable when provider revocation fails", async () => {
    const harness = controlHarness({
      revokeError: new Error("provider unavailable"),
    });

    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).rejects.toThrow(
      "provider unavailable",
    );

    expect(harness.prisma.computer.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.prisma.computer.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "computer-id", controlLeaseId: "lease-1" }),
      data: { controlLeaseExpiresAt: new Date(0) },
    });
    expect(harness.events.releaseUserControl).not.toHaveBeenCalled();
  });

  it("releases the lease and drops the dead ref when the sandbox is already gone", async () => {
    const harness = controlHarness({
      revokeError: Object.assign(new Error("No such container"), {
        name: "SandboxNotFoundError",
      }),
    });

    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(true);

    expect(harness.prisma.computer.updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-id",
        providerRef: "computer",
        state: { notIn: ["booting", "suspending"] },
        controlLeaseId: "lease-1",
      },
      data: { state: "stopped", providerRef: null },
    });
    expect(harness.events.releaseUserControl).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", reason: "expired" }),
    );
  });

  it("clears an orphaned lease instead of rescheduling when the sandbox is gone", async () => {
    const harness = controlHarness({
      controlBotId: null,
      revokeError: Object.assign(new Error("No such container"), {
        name: "SandboxNotFoundError",
      }),
    });

    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(true);

    expect(harness.events.releaseUserControl).toHaveBeenCalledWith(
      expect.objectContaining({ botId: null, leaseId: "lease-1", reason: "expired" }),
    );
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("retries atomic lease cleanup when release-event persistence fails", async () => {
    const harness = controlHarness({ finalizeError: new Error("event unavailable") });

    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).rejects.toThrow(
      "event unavailable",
    );
    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(true);

    expect(harness.events.releaseUserControl).toHaveBeenCalledTimes(2);
  });

  it("does not revoke a replacement lease", async () => {
    const harness = controlHarness({ controlLeaseId: "lease-2" });
    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(
      false,
    );
    expect(harness.setScreenControl).not.toHaveBeenCalled();
    expect(harness.prisma.computer.updateMany).not.toHaveBeenCalled();
  });

  it("revokes screen control, counting a gone sandbox as released", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { computer: { updateMany } } as unknown as PrismaClient;
    const setScreenControl = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("No such container"), { name: "SandboxNotFoundError" }),
      );
    const sandbox = { setScreenControl } as unknown as SandboxProvider;
    const computer = {
      id: "computer-1",
      homeKey: "bot-1",
      kind: "docker",
      providerRef: "provider-1",
    };
    const context = {
      operationId: "op",
      traceId: "op",
      spaceId: "workspace",
      userId: "user",
      signal: new AbortController().signal,
    };

    await revokeScreenControl({ prisma, sandbox }, computer, context, "lease-1");

    expect(setScreenControl).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "provider-1" }),
      false,
      context,
      "lease-1",
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-1",
        providerRef: "provider-1",
        state: { notIn: ["booting", "suspending"] },
        controlLeaseId: "lease-1",
      },
      data: { state: "stopped", providerRef: null },
    });
  });

  it("rethrows a live-sandbox revoke failure and leaves the ref alone", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { computer: { updateMany } } as unknown as PrismaClient;
    const setScreenControl = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const sandbox = { setScreenControl } as unknown as SandboxProvider;
    const computer = {
      id: "computer-1",
      homeKey: "bot-1",
      kind: "docker",
      providerRef: "provider-1",
    };

    await expect(
      revokeScreenControl({ prisma, sandbox }, computer, contextStub(), "lease-1"),
    ).rejects.toThrow("provider unavailable");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("keeps the dead ref for a mid-replacement revoke on a gone sandbox", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { computer: { updateMany } } as unknown as PrismaClient;
    const setScreenControl = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("No such container"), { name: "SandboxNotFoundError" }),
      );
    const sandbox = { setScreenControl } as unknown as SandboxProvider;
    const computer = {
      id: "computer-1",
      homeKey: "bot-1",
      kind: "docker",
      providerRef: "provider-1",
    };

    await revokeScreenControl({ prisma, sandbox }, computer, contextStub(), "lease-1", {
      clearGoneRef: false,
    });

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("skips the provider entirely when the computer has no ref", async () => {
    const prisma = { computer: { updateMany: vi.fn() } } as unknown as PrismaClient;
    const setScreenControl = vi.fn();
    const sandbox = { setScreenControl } as unknown as SandboxProvider;

    await revokeScreenControl(
      { prisma, sandbox },
      { id: "computer-1", homeKey: "bot-1", kind: "docker", providerRef: null },
      contextStub(),
      "lease-1",
    );

    expect(setScreenControl).not.toHaveBeenCalled();
  });

  it("clears user control left without a lease, and never a lease awaiting revocation", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { computer: { updateMany } } as unknown as PrismaClient;

    await expect(clearInactiveUserComputerControl(prisma, "computer-1")).resolves.toBe(true);
    expect(updateMany.mock.calls[0]?.[0].where).toEqual({
      id: "computer-1",
      controlHolder: "user",
      controlLeaseId: null,
    });
  });

  it("revokes then clears orphaned user control when expiry has no control bot id", async () => {
    const harness = controlHarness({ controlBotId: null });
    await expect(expireComputerControl(harness.deps, "computer-id", "lease-1")).resolves.toBe(true);
    expect(harness.setScreenControl).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer" }),
      false,
      expect.objectContaining({ operationId: "computer.control-expire" }),
      "lease-1",
    );
    expect(harness.events.releaseUserControl).toHaveBeenCalledWith(
      expect.objectContaining({ botId: null, leaseId: "lease-1", reason: "expired" }),
    );
  });
});

function contextStub(): AdapterContext {
  return {
    operationId: "op",
    traceId: "op",
    spaceId: "workspace",
    userId: "user",
    signal: new AbortController().signal,
  };
}

function controlHarness(
  options: {
    controlLeaseId?: string;
    controlLeaseExpiresAt?: Date | null;
    controlBotId?: string | null;
    revokeError?: Error;
    finalizeError?: Error;
    enqueueError?: Error;
  } = {},
) {
  const computer = {
    id: "computer-id",
    homeKey: "team-workspace",
    providerRef: "computer",
    kind: "docker",
    state: "running",
    controlHolder: "user",
    controlLeaseId: options.controlLeaseId ?? "lease-1",
    controlBotId: options.controlBotId === undefined ? "bot" : options.controlBotId,
    controlLeaseExpiresAt:
      options.controlLeaseExpiresAt === undefined
        ? new Date("2026-01-01T00:00:00.000Z")
        : options.controlLeaseExpiresAt,
    spaceId: "workspace",
    userId: "user",
  };
  const prisma = {
    computer: {
      findUnique: vi.fn().mockResolvedValue(computer),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    bot: {
      findUnique: vi.fn().mockResolvedValue({
        id: "bot",
        thread: { id: "thread" },
        computer,
      }),
    },
  };
  const setScreenControl = vi.fn(async () => {
    if (options.revokeError) throw options.revokeError;
  });
  const sandbox = { setScreenControl };
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  if (options.enqueueError) enqueue.mockRejectedValueOnce(options.enqueueError);
  const jobs = { enqueue, cancel: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
  const releaseUserControl = vi.fn().mockResolvedValue(true);
  if (options.finalizeError) {
    releaseUserControl.mockRejectedValueOnce(options.finalizeError);
  }
  const events = {
    append: vi.fn().mockResolvedValue({}),
    releaseUserControl,
  };
  return {
    computer,
    prisma,
    setScreenControl,
    enqueue,
    events,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      sandbox: sandbox as unknown as SandboxProvider,
      jobs: jobs as unknown as JobPublisher,
      events: events as unknown as ThreadEvents,
    },
  };
}
