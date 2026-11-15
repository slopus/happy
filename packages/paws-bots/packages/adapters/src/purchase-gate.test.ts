import type { BrowserProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { PurchaseApproval } from "./purchase-gate.js";
import { detectPurchase, purchaseApprovalOf, purchaseCardSummary } from "./purchase-gate.js";
import type { RunContext } from "./run-context.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";

const CHECKED = "The button label and total are read from the page. The bot has not checked them.";
const found = {
  steps: [],
  site: "shop.example.test",
  label: "Pay‮ now\n",
  amount: " $5 ",
  amountSource: "button" as const,
};

function contextWith(
  check: BrowserProvider["purchaseCheck"],
  overrides: Record<string, unknown> = {},
) {
  return {
    deps: {},
    run: { spaceId: "s", userId: "u" },
    bot: { id: "b" },
    context: { signal: new AbortController().signal },
    providers: { browser: { purchaseCheck: check } },
    state: { walletHosts: new Set<string>() },
    secrets: [],
    computer: { pageBrowserAllowed: true, heldForTakeover: false, get: async () => ({ id: "c" }) },
    ...overrides,
  } as unknown as RunContext;
}

describe("purchase detection for the page tools", () => {
  it("asks the browser about a click or Enter on the screen, and about nothing else", async () => {
    const check = vi.fn(async (_computer: unknown, _request: unknown) => ({ purchase: found }));
    const ctx = contextWith(check as never);
    const act = (actions: unknown[]) => detectPurchase(ctx, "computer_act", { actions });
    expect(await act([{ kind: "click", x: 1, y: 2 }])).toMatchObject({ site: "shop.example.test" });
    // Each click goes with its spot on the screen, so only the control under it is judged.
    expect(check).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ desktop: true, enter: false, points: [{ x: 1, y: 2 }] }),
      expect.anything(),
    );
    await act([{ kind: "key", key: "Return" }]);
    expect(check).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ desktop: true, enter: true }),
      expect.anything(),
    );
    await act([{ kind: "type", text: "4242\n" }]);
    expect(check).toHaveBeenCalledTimes(3);
    check.mockClear();
    await act([
      { kind: "move", x: 7, y: 8 },
      { kind: "click", x: 5, y: 6 },
    ]);
    expect(check.mock.calls[0]?.[1]).toMatchObject({
      points: [{ x: 5, y: 6 }],
      unplaced: false,
    });
    check.mockClear();
    await act([{ kind: "type", text: "4242" }, { kind: "key", key: "Tab" }, { kind: "scroll" }]);
    expect(check).not.toHaveBeenCalled();
    check.mockClear();
    check.mockImplementation(async () => ({ purchase: found }));
    await act([{ kind: "type", text: "4242\n" }]);
    expect(check).toHaveBeenCalledOnce();
  });

  it("cannot place a click that follows another step of the batch, or an up that has no pointer", async () => {
    const request = async (actions: unknown[]) => {
      const check = vi.fn(async (_computer: unknown, _request: unknown) => ({ purchase: null }));
      await detectPurchase(contextWith(check as never), "computer_act", { actions });
      return check.mock.calls[0]?.[1];
    };
    const click = { kind: "click", x: 5, y: 6 };
    // The first click is placed; anything after a click, key, typing, wait or scroll is not.
    expect(await request([click])).toMatchObject({ points: [{ x: 5, y: 6 }], unplaced: false });
    for (const before of [
      click,
      { kind: "key", key: "Tab" },
      { kind: "type", text: "4242" },
      { kind: "wait", ms: 100 },
      { kind: "scroll", direction: "down" },
      { kind: "down", x: 1, y: 1 },
    ]) {
      expect(
        await request([before, { kind: "click", x: 9, y: 9 }]),
        JSON.stringify(before),
      ).toMatchObject({
        unplaced: true,
      });
    }
    // Moves only place the pointer; they press nothing and do not disturb the page.
    expect(await request([{ kind: "move", x: 1, y: 2 }, click])).toMatchObject({
      points: [{ x: 5, y: 6 }],
      unplaced: false,
    });
    // An up is checked where the pointer is (the main screen) and at its own spot (an extra display).
    expect(
      await request([
        { kind: "move", x: 1, y: 2 },
        { kind: "up", x: 99, y: 99 },
      ]),
    ).toMatchObject({
      points: [
        { x: 1, y: 2 },
        { x: 99, y: 99 },
      ],
      unplaced: false,
    });
    expect(await request([{ kind: "up", x: 99, y: 99 }])).toMatchObject({
      points: [{ x: 99, y: 99 }],
      unplaced: true,
    });
    expect(await request([{ kind: "up" }])).toMatchObject({ points: [], unplaced: true });
    expect(await request([{ kind: "click" }])).toMatchObject({ points: [], unplaced: true });
    // Checked where the desktop presses: at the rounded spot.
    expect(await request([{ kind: "click", x: 5.4, y: 6.6 }])).toMatchObject({
      points: [{ x: 5, y: 7 }],
    });
    // A right-click presses nothing, so it is not asked about.
    expect(await request([{ kind: "click", x: 5, y: 6, button: "right" }])).toBeUndefined();
  });

  it("takes typing a line break, or only spaces, as a press", async () => {
    const check = vi.fn(async (_computer: unknown, _request: unknown) => ({ purchase: found }));
    const ctx = contextWith(check as never);
    for (const text of ["\n", "done\r", " ", "  "]) {
      check.mockClear();
      await detectPurchase(ctx, "computer_act", { actions: [{ kind: "type", text }] });
      expect(check.mock.calls[0]?.[1], JSON.stringify(text)).toMatchObject({ enter: true });
    }
    check.mockClear();
    await detectPurchase(ctx, "computer_act", {
      actions: [{ kind: "type", text: "Ada Lovelace" }],
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("takes every key that submits, with its modifiers written either way", async () => {
    const check = vi.fn(async (_computer: unknown, _request: unknown) => ({ purchase: found }));
    const ctx = contextWith(check as never);
    const keys = ["Return", "KP_Enter", "enter", "ISO_Enter", "Linefeed", "space", "KP_Space"];
    for (const key of [...keys, ...keys.map((name) => `shift+${name}`), "ctrl+alt+Return"]) {
      check.mockClear();
      await detectPurchase(ctx, "computer_act", { actions: [{ kind: "key", key }] });
      expect(check, key).toHaveBeenCalledOnce();
      expect(check.mock.calls[0]?.[1], key).toMatchObject({ desktop: true, enter: true });
    }
    check.mockClear();
    await detectPurchase(ctx, "computer_act", {
      actions: [{ kind: "key", key: "Return", modifiers: ["shift"] }],
    });
    expect(check).toHaveBeenCalledOnce();
    // The submitting key may be any part of the key, or any modifier.
    for (const step of [
      { key: "a", modifiers: ["Return"] },
      { key: "Return+a" },
      { key: "ctrl+Return+a" },
      { key: "Tab", modifiers: ["shift", "space"] },
    ]) {
      check.mockClear();
      await detectPurchase(ctx, "computer_act", { actions: [{ kind: "key", ...step }] });
      expect(check, JSON.stringify(step)).toHaveBeenCalledOnce();
    }
    check.mockClear();
    for (const key of ["Tab", "Escape", "a", "ctrl+a", "shift+Tab", "ctrl+Home"]) {
      await detectPurchase(ctx, "computer_act", { actions: [{ kind: "key", key }] });
    }
    expect(check).not.toHaveBeenCalled();
  });

  it("presses an approved desktop purchase only while the page still shows what the card did", async () => {
    let now: typeof found | null = found;
    const ctx = contextWith(vi.fn(async () => ({ purchase: now })));
    const replay = async (approval: Record<string, unknown>) =>
      prepareToolRequest(ctx, {
        name: "computer_act",
        nextApprovedTool: "computer_act",
        args: { actions: [{ kind: "click", x: 1, y: 2 }], purchaseApproval: approval },
      } as unknown as ToolRequest);
    const approval = { steps: [], site: "shop.example.test", label: "Pay now", amount: "$5" };
    expect(await replay(approval)).toBeUndefined();
    const changed = { error: expect.stringContaining("nothing was pressed") };
    now = { ...found, amount: "$50" };
    expect(await replay(approval)).toEqual(changed);
    now = null;
    expect(await replay(approval)).toEqual(changed);
    // A card that named nothing, because the check failed, has nothing to compare.
    expect(await replay({ steps: [], site: "", label: "", amount: "" })).toBeUndefined();
  });

  it("shows no card only where this run typed an approved wallet card or token, and still approves the click", async () => {
    const check = vi.fn(async () => ({ purchase: { ...found, steps: [0] } }));
    const ctx = contextWith(check);
    const prepare = async () => {
      const request = {
        name: "browser_act",
        args: { actions: [{ kind: "click", ref: "e1" }] },
      } as unknown as ToolRequest;
      expect(await prepareToolRequest(ctx, request)).toBeUndefined();
      return request;
    };
    expect((await prepare()).purchase).toBeDefined();
    ctx.state.walletHosts.add("other.example.test");
    expect((await prepare()).purchase).toBeDefined();
    ctx.state.walletHosts.add("shop.example.test");
    const exempt = await prepare();
    expect(exempt.purchase).toBeUndefined();
    expect(exempt.fleetSummary).toBeUndefined();
    // The page helper refuses an unapproved purchase click, so the exempt click carries its approval.
    expect(exempt.args.purchaseApproval).toMatchObject({ steps: [0], site: "shop.example.test" });
    // It is spent: a second purchase on that host asks.
    expect((await prepare()).purchase).toBeDefined();
    expect([...ctx.state.walletHosts]).toEqual(["other.example.test"]);
  });

  it("never stores a value the run keeps secret, even when the page shows it on the button", async () => {
    const check = vi.fn(async () => ({
      purchase: { ...found, label: "Pay with 4242424242424242", amount: "$5" },
    }));
    const ctx = contextWith(check as never, { secrets: ["4242424242424242"] });
    const purchase = await detectPurchase(ctx, "browser_act", {
      actions: [{ kind: "click", ref: "e1" }],
    });
    expect(purchase?.label).not.toContain("4242424242424242");
  });

  it("keeps only the page's visible words and bounds them", async () => {
    const purchase = await detectPurchase(
      contextWith(async () => ({ purchase: found })),
      "computer_act",
      { actions: [{ kind: "click", x: 1, y: 2 }] },
    );
    expect(purchase).toEqual({
      steps: [],
      site: "shop.example.test",
      label: "Pay now",
      amount: "$5",
      amountSource: "button",
    });
  });

  it("cuts the page's words by characters, so no half of an emoji is stored", async () => {
    const long = { ...found, label: `${"a".repeat(79)}😀tail`, amount: `${"1".repeat(39)}😀` };
    const purchase = await detectPurchase(
      contextWith(async () => ({ purchase: long })),
      "computer_act",
      { actions: [{ kind: "click", x: 1, y: 2 }] },
    );
    expect(purchase?.label).toBe(`${"a".repeat(79)}😀`);
    expect(Array.from(purchase?.amount ?? "")).toHaveLength(40);
    expect(JSON.stringify(purchase)).not.toMatch(/\\ud[89ab][0-9a-f]{2}"/i);
  });

  it("asks about nothing when there is no way to check", async () => {
    const args = { actions: [{ kind: "click", x: 1, y: 2 }] };
    expect(await detectPurchase(contextWith(undefined), "computer_act", args)).toBeUndefined();
    const check = vi.fn(async () => ({ purchase: found }));
    const held = contextWith(check, {
      computer: { pageBrowserAllowed: true, heldForTakeover: true, get: async () => ({}) },
    });
    expect(await detectPurchase(held, "computer_act", args)).toBeUndefined();
    const off = contextWith(check, { computer: { pageBrowserAllowed: false } });
    expect(await detectPurchase(off, "computer_act", args)).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it("asks about a press after the batch opens a URL, without looking at the page first", async () => {
    const check = vi.fn(async () => ({ purchase: null }));
    const ctx = contextWith(check as never);
    const act = (actions: unknown[]) => detectPurchase(ctx, "computer_act", { actions });
    const unchecked = { steps: [], site: "", label: "", amount: "", amountSource: "page" };
    const open = { kind: "focus", app: "chromium", uri: "https://shop.example.test/checkout" };
    for (const press of [
      { kind: "click", x: 5, y: 6 },
      { kind: "key", key: "Return" },
      { kind: "key", key: "a", modifiers: ["Return"] },
      { kind: "type", text: "go\n" },
    ]) {
      expect(await act([open, press])).toEqual(unchecked);
    }
    expect(check).not.toHaveBeenCalled();
    // A focus that opens nothing, or a URL opened after the press, is checked as usual.
    expect(
      await act([
        { kind: "focus", app: "chromium" },
        { kind: "click", x: 5, y: 6 },
      ]),
    ).toBeUndefined();
    expect(await act([{ kind: "click", x: 5, y: 6 }, open])).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("reads a stored approval only when it is whole", () => {
    const good = {
      steps: [0, 3],
      site: "shop.example.test:8443",
      label: "",
      amount: "",
      amountSource: "page" as const,
    };
    expect(purchaseApprovalOf(good)).toEqual(good);
    expect(purchaseApprovalOf({ ...good, amountSource: undefined })).toEqual(good);
    // A check that failed knows no site.
    expect(purchaseApprovalOf({ ...good, site: "" })).toEqual({ ...good, site: "" });
    expect(purchaseCardSummary({ ...good, site: "" })).toEqual({
      onceOnly: true,
      title: "Complete a payment on this page?",
      lines: ["The page could not be checked, so this may complete a payment."],
    });
    for (const bad of [
      null,
      "x",
      { ...good, steps: [-1] },
      { ...good, steps: [1.5] },
      { ...good, steps: "1" },
      { ...good, site: "bad site" },
      { ...good, label: 1 },
    ]) {
      expect(purchaseApprovalOf(bad)).toBeUndefined();
    }
  });

  it("escapes the site in the card title and leaves out what the page did not show", () => {
    const approval = {
      steps: [],
      site: "a_b*.test",
      label: "",
      amount: "",
      amountSource: "page",
    } satisfies PurchaseApproval;
    // A purchase is approved one click at a time: the card never offers Always allow.
    expect(purchaseCardSummary(approval)).toEqual({
      onceOnly: true,
      title: "Pay on a\\_b\\*.test?",
      receipt: { items: [], amountSource: "page" },
      lines: [CHECKED],
    });
    const shop = { steps: [], site: "shop.test", label: "Pay $5", amount: "$5" };
    expect(purchaseCardSummary({ ...shop, amountSource: "page" }).lines).toEqual([
      'Button: "Pay $5"',
      "Total on the page: $5",
      CHECKED,
    ]);
    expect(purchaseCardSummary({ ...shop, amountSource: "button" }).lines).toEqual([
      'Button: "Pay $5"',
      "Amount on the button: $5",
      CHECKED,
    ]);
    // A button that names less than the checkout's total shows both.
    expect(purchaseCardSummary({ ...shop, amountSource: "button", total: "$12" }).lines).toEqual([
      'Button: "Pay $5"',
      "Amount on the button: $5",
      "Total on the page: $12",
      CHECKED,
    ]);
    expect(purchaseCardSummary({ ...shop, amountSource: "button", total: "$12" }).receipt).toEqual({
      button: "Pay $5",
      items: [],
      amount: "$5",
      amountSource: "button",
      total: "$12",
    });
    expect(purchaseApprovalOf({ ...shop, steps: [0], total: "$12" })).toMatchObject({
      total: "$12",
    });
  });

  it("lists the order lines the page shows, at most eight, between the button and the total", () => {
    const shop = {
      steps: [],
      site: "freshcart.test",
      label: "Pay $23.40",
      amount: "$23.40",
      amountSource: "button",
    } satisfies PurchaseApproval;
    const items = [
      { name: "Bananas × 6", amount: "$3.00" },
      { name: "Oat milk 1L × 2", amount: "$8.40" },
      { name: "Delivery", amount: "$6.00" },
    ];
    expect(purchaseCardSummary({ ...shop, items }).lines).toEqual([
      'Button: "Pay $23.40"',
      "Bananas × 6: $3.00",
      "Oat milk 1L × 2: $8.40",
      "Delivery: $6.00",
      "Amount on the button: $23.40",
      "The button label, items and total are read from the page. The bot has not checked them.",
    ]);
    // Apps draw the same order as a receipt.
    expect(purchaseCardSummary({ ...shop, items }).receipt).toEqual({
      button: "Pay $23.40",
      items,
      amount: "$23.40",
      amountSource: "button",
    });
    const line = (n: number) => ({ name: `Item ${n}`, amount: "$1" });
    const lines = (count: number) =>
      purchaseCardSummary({ ...shop, items: Array.from({ length: count }, (_, n) => line(n)) })
        .lines;
    expect(lines(8).filter((text) => text.startsWith("Item "))).toHaveLength(8);
    const long = lines(12);
    expect(long.filter((text) => text.startsWith("Item "))).toHaveLength(7);
    expect(long[8]).toBe("and 5 more");
    // The page reads no more than 30 lines, so a full list may stand for a longer order.
    expect(lines(30)[8]).toBe("and 23+ more");
    const receipt = (count: number) =>
      purchaseCardSummary({ ...shop, items: Array.from({ length: count }, (_, n) => line(n)) })
        .receipt;
    expect(receipt(12)).toMatchObject({ more: { count: 5, atLeast: false } });
    expect(receipt(12)?.items).toHaveLength(7);
    expect(receipt(30)).toMatchObject({ more: { count: 23, atLeast: true } });
    expect(receipt(8)?.more).toBeUndefined();
    // A computer that lists none, or an older one, shows the card as before.
    expect(purchaseCardSummary({ ...shop, items: [] }).lines).toEqual(
      purchaseCardSummary(shop).lines,
    );
  });

  it("reads stored order lines as page text, dropping anything else", () => {
    const stored = {
      steps: [0],
      site: "freshcart.test",
      label: "Place order",
      amount: "$9",
      items: [
        { name: " Bananas\u202e \u001f × 6\u0007", amount: "$3.00" },
        { name: "No amount" },
        { name: "Amount on the button", amount: "$1" },
        { name: "On the button", amount: "$1" },
        { name: "Total due", amount: "$1" },
        { name: 'Button: "Place order"', amount: "$1" },
        "Delivery $6.00",
        { name: "", amount: "$1" },
      ],
    };
    expect(purchaseApprovalOf(stored)?.items).toEqual([{ name: "Bananas × 6", amount: "$3.00" }]);
    expect(purchaseApprovalOf({ ...stored, items: "Bananas" })).not.toHaveProperty("items");
    expect(purchaseApprovalOf({ ...stored, items: [] })).not.toHaveProperty("items");
  });

  it("stores the page's order lines bounded, without a value the run keeps secret", async () => {
    const items = [
      { name: "Gift for 4242424242424242", amount: "$5" },
      { name: `Note ${"a".repeat(70)}${"9".repeat(30)}`, amount: "$5" },
      { name: `Tax ${"a".repeat(100)}`, amount: "$1" },
      ...Array.from({ length: 40 }, () => ({ name: "Gum", amount: "$1" })),
    ];
    const ctx = contextWith(async () => ({ purchase: { ...found, items } }) as never, {
      secrets: ["4242424242424242", "9".repeat(30)],
    });
    const purchase = await detectPurchase(ctx, "computer_act", {
      actions: [{ kind: "click", x: 1, y: 2 }],
    });
    expect(JSON.stringify(purchase)).not.toContain("4242424242424242");
    // A secret the name limit would cut is still redacted whole: not even its start is kept.
    expect(purchase?.items?.[1]?.name).not.toMatch(/9{5}/);
    expect(purchase?.items?.[2]).toEqual({ name: `Tax ${"a".repeat(76)}`, amount: "$1" });
    expect(purchase?.items).toHaveLength(30);
  });

  it("shows the order lines on the card a pay click asks with", async () => {
    const items = [{ name: "Bananas × 6", amount: "$3.00" }];
    const ctx = contextWith(async () => ({ purchase: { ...found, steps: [0], items } }));
    const request = {
      name: "browser_act",
      args: { actions: [{ kind: "click", ref: "e1" }] },
    } as unknown as ToolRequest;
    expect(await prepareToolRequest(ctx, request)).toBeUndefined();
    expect(request.purchase?.items).toEqual(items);
    expect(request.args.purchaseApproval).toMatchObject({ items });
    expect(request.fleetSummary?.lines).toContain("Bananas × 6: $3.00");
    // A replay of the approved desktop press does not hold the page to its order lines: the total does.
    const replay = {
      name: "computer_act",
      nextApprovedTool: "computer_act",
      args: {
        actions: [{ kind: "click", x: 1, y: 2 }],
        purchaseApproval: {
          steps: [],
          site: "shop.example.test",
          label: "Pay now",
          amount: "$5",
          items,
        },
      },
    } as unknown as ToolRequest;
    expect(await prepareToolRequest(ctx, replay)).toBeUndefined();
  });
});
