import type { ModelRoleSettings } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createModelRoleSettings, modelRoleListPatch } from "./model-role-settings.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const empty: ModelRoleSettings = { primary: null, backups: [] };
const saved: ModelRoleSettings = {
  primary: { provider: "openrouter", modelId: "typesafe/jev-1.14" },
  backups: [],
};
function setup(key = crypto.randomUUID()) {
  const transport = {
    load: vi.fn(async () => empty),
    catalog: vi.fn(async () => []),
    save: vi.fn(async (_patch: Partial<ModelRoleSettings>) => saved),
  };
  return { transport, controller: createModelRoleSettings(transport, key), key };
}
describe("shared model role settings lifecycle", () => {
  it("shows initial settings at once and replaces them when the load returns", async () => {
    const transport = {
      load: vi.fn(async () => empty),
      catalog: vi.fn(async () => []),
      save: vi.fn(async (_patch: Partial<ModelRoleSettings>) => saved),
    };
    const controller = createModelRoleSettings(transport, crypto.randomUUID(), {
      settings: saved,
      catalog: [],
    });
    expect(controller.snapshot()).toMatchObject({ settings: saved, busy: false });
    const loading = controller.load();
    expect(controller.snapshot()).toMatchObject({ settings: saved, busy: true });
    await loading;
    expect(controller.snapshot()).toMatchObject({ settings: empty, busy: false });
  });
  it("prevents replacing unseen settings, allows retry, and preserves saved settings on failure", async () => {
    const { transport, controller } = setup();
    transport.load.mockRejectedValueOnce(new Error("offline"));
    await controller.load();
    await controller.save({ backups: [] });
    expect(transport.save).not.toHaveBeenCalled();
    await controller.load();
    transport.save.mockRejectedValueOnce(new Error("save failed"));
    await controller.save({ primary: saved.primary });
    expect(controller.snapshot()).toMatchObject({
      settings: empty,
      error: "save failed",
      busy: false,
    });
  });
  it("blocks edits built on outdated settings after a failed reload until a load succeeds", async () => {
    const { transport, controller } = setup();
    await controller.load();
    transport.load.mockRejectedValueOnce(new Error("offline"));
    await controller.load();
    expect(controller.snapshot()).toMatchObject({ stale: true, error: "offline" });
    await controller.save({ backups: [] });
    expect(transport.save).not.toHaveBeenCalled();
    await controller.load();
    expect(controller.snapshot().stale).toBe(false);
    await controller.save({ backups: [] });
    expect(transport.save).toHaveBeenCalledTimes(1);
  });
  it("waits for an accepted write before reopening the same role and serializes edits", async () => {
    const { transport, controller, key } = setup();
    await controller.load();
    const write = deferred<ModelRoleSettings>();
    transport.save.mockReturnValueOnce(write.promise);
    const saving = controller.save({ primary: saved.primary });
    const secondSave = controller.save({ primary: null });
    const reopened = createModelRoleSettings(transport, key);
    transport.load.mockResolvedValue(saved);
    const loading = reopened.load();
    await Promise.resolve();
    expect(transport.load).toHaveBeenCalledTimes(1);
    write.resolve(saved);
    await Promise.all([saving, secondSave, loading]);
    expect(transport.save).toHaveBeenCalledTimes(2);
    expect(reopened.snapshot().settings).toEqual(saved);
  });
  it("applies a save issued during a load once the load settles, against the loaded settings", async () => {
    const { transport, controller } = setup();
    const loaded: ModelRoleSettings = {
      primary: saved.primary,
      backups: [{ provider: "openrouter", modelId: "chat" }],
    };
    const load = deferred<ModelRoleSettings>();
    transport.load.mockReturnValueOnce(load.promise);
    transport.save.mockImplementation(async (patch) => ({ ...loaded, ...patch }));
    const loading = controller.load();
    const seen = vi.fn((settings: ModelRoleSettings) => ({
      backups: [...settings.backups, { provider: "openrouter", modelId: "mini" }],
    }));
    const saving = controller.save(seen);
    await Promise.resolve();
    expect(transport.save).not.toHaveBeenCalled();
    load.resolve(loaded);
    await Promise.all([loading, saving]);
    expect(seen).toHaveBeenCalledWith(loaded);
    expect(transport.save).toHaveBeenCalledWith({
      backups: [
        { provider: "openrouter", modelId: "chat" },
        { provider: "openrouter", modelId: "mini" },
      ],
    });
    expect(controller.snapshot().settings).toEqual({
      primary: saved.primary,
      backups: [
        { provider: "openrouter", modelId: "chat" },
        { provider: "openrouter", modelId: "mini" },
      ],
    });
  });
  it("waits for a newer load that starts while a save is waiting", async () => {
    const { transport, controller } = setup();
    const first = deferred<ModelRoleSettings>();
    transport.load.mockReturnValueOnce(first.promise).mockResolvedValueOnce(saved);
    void controller.load();
    const seen = vi.fn(() => ({ backups: [] }));
    const saving = controller.save(seen);
    const second = controller.load();
    first.resolve(empty);
    await Promise.all([second, saving]);
    expect(seen).toHaveBeenCalledExactlyOnceWith(saved);
    expect(transport.save).toHaveBeenCalledTimes(1);
  });
  it("does not block unrelated roles or scopes and ignores obsolete loads", async () => {
    const { transport, controller } = setup();
    const old = deferred<ModelRoleSettings>();
    transport.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce(saved);
    const first = controller.load();
    await Promise.resolve();
    await controller.load();
    old.resolve(empty);
    await first;
    expect(controller.snapshot().settings).toEqual(saved);
    const other = setup();
    await other.controller.load();
    expect(other.controller.snapshot().settings).toEqual(empty);
  });
});

describe("modelRoleListPatch", () => {
  const primary = { provider: "openrouter", modelId: "typesafe/jev-1.14", credentialId: "a" };
  const backup = { provider: "anthropic", modelId: "opus" };

  it("sends the whole list as fallbacks when no primary is set", () => {
    expect(modelRoleListPatch(empty, [backup])).toEqual({ backups: [backup] });
  });

  it("leaves an unchanged primary out of the save", () => {
    expect(modelRoleListPatch({ primary, backups: [] }, [{ ...primary }, backup])).toEqual({
      backups: [backup],
    });
  });

  it("sends the primary when it changes, including the same model on another connection", () => {
    expect(modelRoleListPatch({ primary, backups: [backup] }, [backup, primary])).toEqual({
      primary: backup,
      backups: [primary],
    });
    const other = { ...primary, credentialId: "b" };
    expect(modelRoleListPatch({ primary, backups: [] }, [other])).toEqual({
      primary: other,
      backups: [],
    });
    expect(modelRoleListPatch({ primary, backups: [] }, [])).toEqual({
      primary: null,
      backups: [],
    });
  });
});
