import { AsyncLocalStorage } from "node:async_hooks";
import type { LogBindings } from "./types.js";

const storage = new AsyncLocalStorage<LogBindings>();

export function getLogContext(): LogBindings {
  return { ...(storage.getStore() ?? {}) };
}

export function runWithLogContext<T>(bindings: LogBindings, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...bindings }, fn);
}

export function enrichLogContext(bindings: LogBindings): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, bindings);
}
