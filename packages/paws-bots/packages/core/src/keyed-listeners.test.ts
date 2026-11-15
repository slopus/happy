import { expect, it, vi } from "vitest";
import { createKeyedListeners } from "./keyed-listeners.js";

it("reaches only the listeners of the key, until they unsubscribe", () => {
  const channel = createKeyedListeners<string>();
  const mine = vi.fn();
  const other = vi.fn();
  const stop = channel.subscribe("bot:a", mine);
  channel.subscribe("bot:b", other);
  channel.emit("bot:a", "Plan lunch");
  stop();
  channel.emit("bot:a", "again");
  expect(mine).toHaveBeenCalledTimes(1);
  expect(mine).toHaveBeenCalledWith("Plan lunch");
  expect(other).not.toHaveBeenCalled();
});
