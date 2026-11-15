/** Listeners grouped by key, such as one chat's composer; a key drops out with its last one. */
export function createKeyedListeners<T>() {
  const listeners = new Map<string, Set<(value: T) => void>>();
  return {
    emit(key: string, value: T): void {
      for (const listener of listeners.get(key) ?? []) listener(value);
    },
    subscribe(key: string, listener: (value: T) => void): () => void {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
  };
}
