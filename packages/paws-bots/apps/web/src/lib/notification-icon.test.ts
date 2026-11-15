import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationIcon, prepareNotificationIcons } from "./notification-icon.js";

let loads: string[];
let failLoad: boolean;
let context: { drawImage: ReturnType<typeof vi.fn> } | null;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    loads.push(value);
    queueMicrotask(() => (failLoad ? this.onerror?.() : this.onload?.()));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  loads = [];
  failLoad = false;
  context = { drawImage: vi.fn() };
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: (type: string) => `data:${type};base64,cG5n`,
    }),
  });
});

afterEach(() => {
  prepareNotificationIcons([]);
  vi.unstubAllGlobals();
});

describe("notificationIcon", () => {
  it("rasterizes a drawn avatar to a 96px PNG once per avatar value", async () => {
    const bot = { id: "drawn", color: "#3366ff" };
    prepareNotificationIcons([bot]);
    expect(notificationIcon(bot)).toBeUndefined();
    await settle();
    prepareNotificationIcons([bot]);
    expect(notificationIcon(bot)).toBe("data:image/png;base64,cG5n");
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatch(/^data:image\/svg\+xml,/);
    expect(context?.drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0, 96, 96);

    const edited = { ...bot, avatarSet: "rakazo" };
    expect(notificationIcon(edited)).toBeUndefined();
    prepareNotificationIcons([edited]);
    expect(loads).toHaveLength(2);
  });

  it("passes an uploaded photo through", () => {
    const bot = { id: "photo", color: "data:image/png;base64,cGhvdG8=" };
    prepareNotificationIcons([bot]);
    expect(notificationIcon(bot)).toBe(bot.color);
    expect(loads).toHaveLength(0);
  });

  it("forgets bots that are no longer listed", () => {
    const bot = { id: "photo", color: "data:image/png;base64,cGhvdG8=" };
    prepareNotificationIcons([bot]);
    prepareNotificationIcons([]);
    expect(notificationIcon(bot)).toBeUndefined();
  });

  it("falls back to the browser default when rasterizing fails", async () => {
    failLoad = true;
    const broken = { id: "broken-load", color: "#3366ff" };
    prepareNotificationIcons([broken]);
    await settle();
    expect(notificationIcon(broken)).toBeUndefined();

    failLoad = false;
    context = null;
    const noCanvas = { id: "no-canvas", color: "#3366ff" };
    prepareNotificationIcons([noCanvas]);
    await settle();
    expect(notificationIcon(noCanvas)).toBeUndefined();
  });
});
