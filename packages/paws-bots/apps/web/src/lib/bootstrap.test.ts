import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => {
  // Query keys walk the client's procedure paths; these tests never call through it.
  const client = (): unknown => new Proxy(() => undefined, { get: () => client() });
  return {
    rpc: { bootstrap: vi.fn() },
    selectedSpaceId: vi.fn(),
    createSpaceRpc: client,
    rpcForSpace: client,
  };
});
vi.mock("./performance", () => ({ markOnce: vi.fn() }));

import { rpc, selectedSpaceId } from "./rpc";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("bootstrap upload configuration", () => {
  it.each([undefined, 2 * 1024 * 1024, 25 * 1024 * 1024])(
    "uses the server limit %s with an older-server fallback",
    async (maxUploadSizeBytes) => {
      vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
      vi.mocked(rpc.bootstrap).mockResolvedValue({
        me: { ticketBoardEnabled: false, maxUploadSizeBytes },
      } as Awaited<ReturnType<typeof rpc.bootstrap>>);
      const { takeInitialBootstrap, getMaxUploadSizeBytes } = await import("./bootstrap");
      await takeInitialBootstrap();
      expect(getMaxUploadSizeBytes()).toBe(maxUploadSizeBytes ?? 10 * 1024 * 1024);
    },
  );
});

describe("switching spaces in place", () => {
  it("loads the other space under its own header and leaves it for the shell", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    const other = { me: { ticketBoardEnabled: false } } as Awaited<
      ReturnType<typeof rpc.bootstrap>
    >;
    vi.mocked(rpc.bootstrap).mockReset().mockResolvedValue(other);
    const { primeSpaceBootstrap, takeInitialBootstrap } = await import("./bootstrap");
    await primeSpaceBootstrap("space-b", "bot-b");
    vi.mocked(selectedSpaceId).mockReturnValue("space-b");
    expect(rpc.bootstrap).toHaveBeenCalledWith(
      { botId: "bot-b" },
      { context: { spaceId: "space-b" } },
    );
    await expect(takeInitialBootstrap("bot-b")).resolves.toBe(other);
    expect(rpc.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("never hands a discarded switch's bootstrap to a later shell", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    vi.mocked(rpc.bootstrap)
      .mockReset()
      .mockResolvedValue({ me: { ticketBoardEnabled: false } } as Awaited<
        ReturnType<typeof rpc.bootstrap>
      >);
    const { discardPrimedBootstrap, primeSpaceBootstrap, takeInitialBootstrap } = await import(
      "./bootstrap"
    );
    const primed = primeSpaceBootstrap("space-b", "bot-b");
    discardPrimedBootstrap(primed);
    await takeInitialBootstrap("bot-b");
    expect(rpc.bootstrap).toHaveBeenLastCalledWith({ botId: "bot-b" });
    expect(rpc.bootstrap).toHaveBeenCalledTimes(2);
  });
});

describe("revisiting a space", () => {
  it("opens with the cached bootstrap and still refreshes it", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    const cached = { me: { ticketBoardEnabled: true, maxUploadSizeBytes: 4321 } } as Awaited<
      ReturnType<typeof rpc.bootstrap>
    >;
    const fresh = { me: { ticketBoardEnabled: false } } as Awaited<
      ReturnType<typeof rpc.bootstrap>
    >;
    vi.mocked(rpc.bootstrap).mockReset().mockResolvedValue(fresh);
    const { getMaxUploadSizeBytes, peekBootstrapSeed, primeSpaceBootstrap, takeInitialBootstrap } =
      await import("./bootstrap");
    void primeSpaceBootstrap("space-b", "bot-b", cached);
    vi.mocked(selectedSpaceId).mockReturnValue("space-b");
    expect(peekBootstrapSeed("bot-b")).toBe(cached);
    expect(peekBootstrapSeed("bot-c")).toBeUndefined();
    const taken = takeInitialBootstrap("bot-b");
    expect(getMaxUploadSizeBytes()).toBe(4321);
    await expect(taken).resolves.toBe(fresh);
    expect(rpc.bootstrap).toHaveBeenCalledWith(
      { botId: "bot-b" },
      { context: { spaceId: "space-b" } },
    );
    expect(peekBootstrapSeed("bot-b")).toBeUndefined();
  });

  it("opens a visited space through any of its chats, not only the one it was left on", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    vi.mocked(rpc.bootstrap)
      .mockReset()
      .mockResolvedValue({ me: { ticketBoardEnabled: false } } as Awaited<
        ReturnType<typeof rpc.bootstrap>
      >);
    const { queryClient, spaceSeedKey } = await import("./query");
    const { peekBootstrapSeed, primeSpaceBootstrap } = await import("./bootstrap");
    // Left while showing bot-b1; the switch back targets bot-b2.
    const left = { me: { spaceId: "space-b" }, thread: { botId: "bot-b1" } } as Awaited<
      ReturnType<typeof rpc.bootstrap>
    >;
    queryClient.setQueryData(spaceSeedKey("user-a", "space-b"), left);
    const seed = queryClient.getQueryData(spaceSeedKey("user-a", "space-b"));
    void primeSpaceBootstrap("space-b", "bot-b2", seed);
    vi.mocked(selectedSpaceId).mockReturnValue("space-b");
    expect(peekBootstrapSeed("bot-b2")).toBe(left);
    expect(queryClient.getQueryData(spaceSeedKey("user-b", "space-b"))).toBeUndefined();
    queryClient.clear();
  });

  it("never seeds a shell for another space", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    vi.mocked(rpc.bootstrap)
      .mockReset()
      .mockResolvedValue({ me: { ticketBoardEnabled: false } } as Awaited<
        ReturnType<typeof rpc.bootstrap>
      >);
    const { peekBootstrapSeed, primeSpaceBootstrap } = await import("./bootstrap");
    void primeSpaceBootstrap("space-b", "bot-b", {} as Awaited<ReturnType<typeof rpc.bootstrap>>);
    vi.mocked(selectedSpaceId).mockReturnValue("space-c");
    expect(peekBootstrapSeed("bot-b")).toBeUndefined();
  });
});

describe("primed space isolation", () => {
  it("applies capabilities only when the selected shell takes the bootstrap", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    const other = { me: { ticketBoardEnabled: true, maxUploadSizeBytes: 1234 } } as Awaited<
      ReturnType<typeof rpc.bootstrap>
    >;
    vi.mocked(rpc.bootstrap).mockReset().mockResolvedValue(other);
    vi.mocked(selectedSpaceId).mockReturnValue("space-b");
    const {
      primeSpaceBootstrap,
      discardPrimedBootstrap,
      takeInitialBootstrap,
      getMaxUploadSizeBytes,
      getTicketBoardEnabled,
      subscribeTicketBoardEnabled,
    } = await import("./bootstrap");
    const initialLimit = getMaxUploadSizeBytes();
    const listener = vi.fn();
    subscribeTicketBoardEnabled(listener);
    const discarded = primeSpaceBootstrap("space-b");
    discardPrimedBootstrap(discarded);
    await discarded;
    expect(getMaxUploadSizeBytes()).toBe(initialLimit);
    expect(getTicketBoardEnabled()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    await primeSpaceBootstrap("space-b");
    expect(getMaxUploadSizeBytes()).toBe(initialLimit);
    await takeInitialBootstrap();
    expect(getMaxUploadSizeBytes()).toBe(1234);
    expect(getTicketBoardEnabled()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not let a superseded response overwrite the selected space's capabilities", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    type Bootstrap = Awaited<ReturnType<typeof rpc.bootstrap>>;
    let resolveOld = (_value: Bootstrap) => {};
    const old = new Promise<Bootstrap>((resolve) => {
      resolveOld = resolve;
    });
    const current = { me: { ticketBoardEnabled: true, maxUploadSizeBytes: 4321 } } as Bootstrap;
    vi.mocked(rpc.bootstrap).mockReset().mockReturnValueOnce(old).mockResolvedValue(current);
    vi.mocked(selectedSpaceId).mockReturnValue("space-c");
    const {
      primeSpaceBootstrap,
      discardPrimedBootstrap,
      takeInitialBootstrap,
      getMaxUploadSizeBytes,
      getTicketBoardEnabled,
    } = await import("./bootstrap");
    const superseded = primeSpaceBootstrap("space-b");
    await primeSpaceBootstrap("space-c");
    discardPrimedBootstrap(superseded);
    await expect(takeInitialBootstrap()).resolves.toBe(current);
    resolveOld({ me: { ticketBoardEnabled: false, maxUploadSizeBytes: 1234 } } as Bootstrap);
    await superseded;
    expect(getMaxUploadSizeBytes()).toBe(4321);
    expect(getTicketBoardEnabled()).toBe(true);
  });

  it("drops another space's group bootstrap and requests the selected space", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    vi.mocked(selectedSpaceId).mockReturnValue("space-a");
    const other = { me: { ticketBoardEnabled: true, maxUploadSizeBytes: 1234 } } as Awaited<
      ReturnType<typeof rpc.bootstrap>
    >;
    const current = { me: { ticketBoardEnabled: false } } as Awaited<
      ReturnType<typeof rpc.bootstrap>
    >;
    vi.mocked(rpc.bootstrap).mockReset().mockResolvedValueOnce(other).mockResolvedValue(current);
    const { primeSpaceBootstrap, takeInitialBootstrap, getTicketBoardEnabled } = await import(
      "./bootstrap"
    );
    await primeSpaceBootstrap("space-b");
    await expect(takeInitialBootstrap()).resolves.toBe(current);
    expect(rpc.bootstrap).toHaveBeenLastCalledWith({});
    expect(rpc.bootstrap).toHaveBeenCalledTimes(2);
    expect(getTicketBoardEnabled()).toBe(false);
  });

  it("does not expose a switch bootstrap to the subscription gate", async () => {
    vi.stubGlobal("window", { location: { pathname: "/sign-in" } });
    vi.mocked(rpc.bootstrap).mockResolvedValue({ me: {} } as Awaited<
      ReturnType<typeof rpc.bootstrap>
    >);
    const { primeSpaceBootstrap, peekInitialBootstrap } = await import("./bootstrap");
    await primeSpaceBootstrap("space-b");
    expect(peekInitialBootstrap()).toBeUndefined();
  });

  it("keeps the first-load speculative bootstrap available without an explicit space", async () => {
    vi.stubGlobal("window", { location: { pathname: "/app" } });
    const initial = { me: { ticketBoardEnabled: true } } as Awaited<
      ReturnType<typeof rpc.bootstrap>
    >;
    vi.mocked(rpc.bootstrap).mockReset().mockResolvedValue(initial);
    const { peekInitialBootstrap, takeInitialBootstrap, getTicketBoardEnabled } = await import(
      "./bootstrap"
    );
    await expect(peekInitialBootstrap()).resolves.toBe(initial);
    expect(getTicketBoardEnabled()).toBe(true);
    await expect(takeInitialBootstrap()).resolves.toBe(initial);
    expect(rpc.bootstrap).toHaveBeenCalledTimes(1);
  });
});
