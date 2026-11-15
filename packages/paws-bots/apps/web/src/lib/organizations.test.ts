import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { landingSpaceId, leaveOrganization, organizationsQuery } from "./organizations";
import { queryClient, spaceQueries } from "./query";
import type * as RpcModule from "./rpc";
import { clearSpaceSelection, rpc, selectSpace } from "./rpc";

vi.mock("./auth", () => ({ authClient: { $store: { notify: vi.fn() } } }));
vi.mock("./rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof RpcModule>()),
  rpc: { organizations: { list: vi.fn() } },
}));

const personal = {
  id: "org-personal",
  name: "Personal",
  defaultSpaceId: "home",
  spaceIds: ["home", "side"],
  canManage: true,
};
const work = {
  id: "org-work",
  name: "Work",
  defaultSpaceId: "work-home",
  spaceIds: ["work-home"],
  canManage: true,
};

let items: Map<string, string>;
beforeEach(() => {
  items = new Map();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    },
    setTimeout: (run: () => void) => run(),
    dispatchEvent: () => true,
  });
  queryClient.setQueryData(organizationsQuery("user-1").queryKey, {
    activeOrganizationId: personal.id,
    organizations: [personal, work],
  });
});
afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("landing Space", () => {
  it("opens the default Space of an organization never visited on this device", () => {
    expect(landingSpaceId(personal)).toBe("home");
  });

  it("returns to the Space last used in the organization", async () => {
    await leaveOrganization("user-1", "side", "work-home");
    expect(landingSpaceId(personal)).toBe("side");
  });

  it("falls back to the default once the last used Space is gone", async () => {
    await leaveOrganization("user-1", "side", "work-home");
    expect(landingSpaceId({ ...personal, spaceIds: ["home"] })).toBe("home");
  });

  it("is forgotten with the Space selection", async () => {
    await leaveOrganization("user-1", "side", "work-home");
    clearSpaceSelection();
    expect(landingSpaceId(personal)).toBe("home");
  });
});

describe("leaving an organization", () => {
  it("drops the cache of the organization left and keeps the one entered", async () => {
    for (const spaceId of ["home", "side", "work-home"]) {
      queryClient.setQueryData(spaceQueries("user-1", spaceId).me.queryKey(), { spaceId } as never);
    }
    await leaveOrganization("user-1", "home", "work-home");
    expect(queryClient.getQueryData(spaceQueries("user-1", "home").me.queryKey())).toBeUndefined();
    expect(queryClient.getQueryData(spaceQueries("user-1", "side").me.queryKey())).toBeUndefined();
    expect(queryClient.getQueryData(spaceQueries("user-1", "work-home").me.queryKey())).toEqual({
      spaceId: "work-home",
    });
  });

  it("loads the organization list when a link crosses organizations before it is cached", async () => {
    queryClient.removeQueries({ queryKey: organizationsQuery("user-1").queryKey });
    vi.mocked(rpc.organizations.list).mockResolvedValueOnce({
      activeOrganizationId: personal.id,
      organizations: [personal, work],
    });
    queryClient.setQueryData(spaceQueries("user-1", "home").me.queryKey(), {
      spaceId: "home",
    } as never);

    await leaveOrganization("user-1", "side", "work-home");

    expect(landingSpaceId(personal)).toBe("side");
    expect(queryClient.getQueryData(spaceQueries("user-1", "home").me.queryKey())).toBeUndefined();
  });

  it("keeps the cache when the selection is back in that organization before it is dropped", async () => {
    queryClient.setQueryData(spaceQueries("user-1", "home").me.queryKey(), {
      spaceId: "home",
    } as never);
    expect(selectSpace("home")).toBe(true);
    await leaveOrganization("user-1", "home", "work-home");
    expect(queryClient.getQueryData(spaceQueries("user-1", "home").me.queryKey())).toEqual({
      spaceId: "home",
    });
  });

  it("keeps everything when moving between Spaces of one organization", async () => {
    queryClient.setQueryData(spaceQueries("user-1", "home").me.queryKey(), {
      spaceId: "home",
    } as never);
    await leaveOrganization("user-1", "home", "side");
    expect(queryClient.getQueryData(spaceQueries("user-1", "home").me.queryKey())).toEqual({
      spaceId: "home",
    });
    expect(items.has("rakazo:org-spaces")).toBe(false);
  });
});
