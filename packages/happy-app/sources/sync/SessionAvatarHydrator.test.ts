import { describe, expect, it, vi } from "vitest";
import { SessionAvatarHydrator } from "./SessionAvatarHydrator";
import type { ProjectAvatar } from "./projectTypes";
import type { SessionAvatarDescriptor } from "./sessionAvatarTypes";

const descriptor = { ref: "sessions/s/avatar/a.enc", preview: "encrypted", version: 1 };
const picture: ProjectAvatar = {
  ref: descriptor.ref,
  version: 1,
  uri: "data:image/webp;base64,YQ==",
  thumbhash: "hash",
  mimeType: "image/webp",
};

describe("session avatar hydration", () => {
  it("deduplicates requests and cannot restore a removed avatar after a late download", async () => {
    let current: { avatarDescriptor: SessionAvatarDescriptor | null } = {
      avatarDescriptor: descriptor,
    };
    let finish!: (avatar: ProjectAvatar) => void;
    const load = vi.fn(
      () =>
        new Promise<ProjectAvatar>((resolve) => {
          finish = resolve;
        }),
    );
    const publish = vi.fn();
    const loader = new SessionAvatarHydrator({ read: () => current, load, publish });
    loader.refresh("s");
    loader.refresh("s");
    expect(load).toHaveBeenCalledTimes(1);
    current = { avatarDescriptor: null };
    loader.refresh("s");
    finish(picture);
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
    loader.clear();
  });

  it("ignores a stale replacement and publishes the latest picture", async () => {
    let current = { avatarDescriptor: descriptor };
    const finishes: ((avatar: ProjectAvatar) => void)[] = [];
    const publish = vi.fn();
    const loader = new SessionAvatarHydrator({
      read: () => current,
      publish,
      load: () => new Promise((resolve) => finishes.push(resolve)),
    });
    loader.refresh("s");
    current = { avatarDescriptor: { ...descriptor, ref: "sessions/s/avatar/b.enc", version: 2 } };
    loader.refresh("s");
    finishes[0](picture);
    const replacement = { ...picture, ref: current.avatarDescriptor.ref, version: 2 };
    finishes[1](replacement);
    await Promise.resolve();
    expect(publish).toHaveBeenCalledExactlyOnceWith("s", replacement);
    loader.clear();
  });

  it("does not reload cached images and bounds pending network work", async () => {
    vi.useFakeTimers();
    let current = { avatarDescriptor: descriptor, avatar: picture as ProjectAvatar | null };
    const load = vi.fn(
      (_id: string, _descriptor: SessionAvatarDescriptor, signal: AbortSignal) =>
        new Promise<null>((resolve) =>
          signal.addEventListener("abort", () => resolve(null), { once: true }),
        ),
    );
    const loader = new SessionAvatarHydrator({ read: () => current, load, publish: vi.fn() });
    loader.refresh("s");
    expect(load).not.toHaveBeenCalled();
    current = { ...current, avatar: null };
    loader.refresh("s");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(load.mock.calls[0][2].aborted).toBe(true);
    loader.clear();
    vi.useRealTimers();
  });
});
