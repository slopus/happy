import type { PageDetail } from "@rakazo/contracts";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { pageMutationOptions, relistPagesForBlocks } from "./page-actions";
import { spaceQueries } from "./query";

const detail = (id: string, title: string): PageDetail => ({
  id,
  title,
  botId: "b1",
  groupId: null,
  visibility: "private",
  currentVersion: 1,
  pinned: false,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
  version: 1,
  code: "",
  owner: { name: "Elie", image: null },
  shareUrl: null,
});

describe("pageMutationOptions", () => {
  it("writes a late answer to the page it was for, not the page open now", () => {
    const queries = spaceQueries("u1", "s1");
    const client = new QueryClient();
    const key = (pageId: string) => queries.pages.get.queryKey({ input: { pageId } });
    client.setQueryData(key("A"), detail("A", "Alpha"));
    client.setQueryData(key("B"), detail("B", "Beta"));
    // The share popover reads the page with its link under its own key.
    const linked = queries.pages.get.queryKey({ input: { pageId: "A", link: true } });
    client.setQueryData(linked, detail("A", "Alpha"));
    const options = pageMutationOptions(queries, client);

    // Started on A; the user has since opened B when these answers arrive.
    options.rename.onSuccess({ ...detail("A", "Renamed"), title: "Renamed" }, { pageId: "A" });
    // A rename changes the share link's slug, so A's reads are fetched again; B's are not.
    expect(client.getQueryState(linked)?.isInvalidated).toBe(true);
    expect(client.getQueryState(key("B"))?.isInvalidated).toBe(false);
    options.setVisibility.onSuccess(
      { visibility: "link", shareUrl: "https://rakazo.example/p/a-x" },
      { pageId: "A" },
    );

    expect(client.getQueryData<PageDetail>(key("A"))).toMatchObject({
      title: "Renamed",
      visibility: "link",
      shareUrl: "https://rakazo.example/p/a-x",
    });
    expect(client.getQueryData<PageDetail>(linked)).toMatchObject({
      shareUrl: "https://rakazo.example/p/a-x",
    });
    expect(client.getQueryData<PageDetail>(key("B"))).toEqual(detail("B", "Beta"));

    options.remove.onSuccess({ ok: true }, { pageId: "A" });
    expect(client.getQueryData(key("A"))).toBeUndefined();
    expect(client.getQueryData<PageDetail>(key("B"))).toEqual(detail("B", "Beta"));
  });
});

describe("relistPagesForBlocks", () => {
  it("relists the palette's plain list and the Library's paged list without reading either", () => {
    const queries = spaceQueries("u1", "s1");
    const client = new QueryClient();
    const palette = queries.pages.list.queryKey({ input: {} });
    const library = queries.pages.list.infiniteKey({
      input: (cursor: string | null) => ({ botId: "b1", limit: 5, ...(cursor ? { cursor } : {}) }),
      initialPageParam: null,
    });
    client.setQueryData(palette, { items: [], nextCursor: null });
    client.setQueryData(library, { pages: [{ items: [], nextCursor: null }], pageParams: [null] });

    relistPagesForBlocks(queries, client, [{ kind: "text" }]);
    expect(client.getQueryState(palette)?.isInvalidated).toBe(false);
    relistPagesForBlocks(queries, client, [{ kind: "page" }]);
    expect(client.getQueryState(palette)?.isInvalidated).toBe(true);
    expect(client.getQueryState(library)?.isInvalidated).toBe(true);
  });
});

describe("removing a page", () => {
  it("treats a page another tab deleted first as deleted, not as a failure", async () => {
    const call = vi.fn();
    const queries = { pages: { remove: { call } } } as unknown as ReturnType<typeof spaceQueries>;
    const options = pageMutationOptions(queries, new QueryClient());
    call.mockRejectedValueOnce(Object.assign(new Error("Not found"), { code: "NOT_FOUND" }));
    await expect(options.remove.mutationFn({ pageId: "A" })).resolves.toEqual({ ok: true });
    call.mockRejectedValueOnce(new Error("offline"));
    await expect(options.remove.mutationFn({ pageId: "A" })).rejects.toThrow("offline");
  });

  it("asks again for a page still on screen, so its card learns it is gone", async () => {
    const queries = spaceQueries("u1", "s1");
    const client = new QueryClient();
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce(detail("A", "Alpha"))
      .mockRejectedValue(Object.assign(new Error("Not found"), { code: "NOT_FOUND" }));
    const card = new QueryObserver(client, {
      queryKey: queries.pages.get.queryKey({ input: { pageId: "A" } }),
      queryFn,
      retry: false,
    });
    const unsubscribe = card.subscribe(() => undefined);
    await vi.waitFor(() => expect(card.getCurrentResult().data).toBeDefined());

    pageMutationOptions(queries, client).remove.onSuccess({ ok: true }, { pageId: "A" });
    await vi.waitFor(() =>
      expect(card.getCurrentResult().error).toMatchObject({ code: "NOT_FOUND" }),
    );
    expect(card.getCurrentResult().data).toBeUndefined();
    unsubscribe();
  });
});

describe("a change whose answer is lost", () => {
  it("reads the page and the lists again after rename, sharing, pin and delete alike", async () => {
    const real = spaceQueries("u1", "s1");
    const client = new QueryClient();
    // The server makes each change, then the connection drops before its answer arrives.
    const server = new Map([["A", detail("A", "Alpha")]]);
    const lost = (change: (page: PageDetail) => void) =>
      vi.fn(async (input: { pageId: string }) => {
        const page = server.get(input.pageId);
        if (page) change(page);
        throw new TypeError("Failed to fetch");
      });
    const queries = {
      pages: {
        get: real.pages.get,
        list: real.pages.list,
        rename: { call: lost((page) => Object.assign(page, { title: "Renamed" })) },
        setVisibility: {
          call: lost((page) =>
            Object.assign(page, { visibility: "link", shareUrl: "https://rakazo.example/p/a" }),
          ),
        },
        pin: { call: lost((page) => Object.assign(page, { pinned: true })) },
        remove: {
          call: vi.fn(async () => {
            server.delete("A");
            throw new TypeError("Failed to fetch");
          }),
        },
      },
    } as unknown as ReturnType<typeof spaceQueries>;
    const open = new QueryObserver(client, {
      queryKey: real.pages.get.queryKey({ input: { pageId: "A" } }),
      queryFn: async () => {
        const page = server.get("A");
        if (!page) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND" });
        return { ...page };
      },
      retry: false,
    });
    const unsubscribe = open.subscribe(() => undefined);
    await vi.waitFor(() => expect(open.getCurrentResult().data?.title).toBe("Alpha"));
    const list = real.pages.list.queryKey({ input: {} });
    const options = pageMutationOptions(queries, client);
    const attempt = async <K extends "rename" | "setVisibility" | "pin" | "remove">(
      name: K,
      input: Parameters<(typeof options)[K]["mutationFn"]>[0],
    ) => {
      client.setQueryData(list, { items: [], nextCursor: null });
      const mutation = new MutationObserver(client, options[name] as never);
      await expect(mutation.mutate(input as never)).rejects.toThrow("Failed to fetch");
      expect(client.getQueryState(list)?.isInvalidated).toBe(true);
    };

    await attempt("rename", { pageId: "A", title: "Renamed" });
    await vi.waitFor(() => expect(open.getCurrentResult().data?.title).toBe("Renamed"));
    await attempt("setVisibility", { pageId: "A", visibility: "link" });
    await vi.waitFor(() =>
      expect(open.getCurrentResult().data).toMatchObject({
        visibility: "link",
        shareUrl: "https://rakazo.example/p/a",
      }),
    );
    await attempt("pin", { pageId: "A", pinned: true });
    await vi.waitFor(() => expect(open.getCurrentResult().data?.pinned).toBe(true));
    await attempt("remove", { pageId: "A" });
    await vi.waitFor(() =>
      expect(open.getCurrentResult().error).toMatchObject({ code: "NOT_FOUND" }),
    );
    unsubscribe();
  });
});
