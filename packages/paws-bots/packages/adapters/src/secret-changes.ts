import type { SecretChangeListener } from "@rakazo/adapter-kit";

/** Store-owned invalidation; listeners never need provider revisions. */
export class SecretChanges {
  private readonly listeners = new Set<SecretChangeListener>();
  onChange(listener: SecretChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  protected changed(ref: string): void {
    for (const listener of this.listeners) {
      try {
        listener(ref);
      } catch {
        /* A consumer cannot fail a persisted write. */
      }
    }
  }
  protected clearListeners(): void {
    this.listeners.clear();
  }
}
