import type { ProjectAvatar } from "./projectTypes";
import { sameSessionAvatar, type SessionAvatarDescriptor } from "./sessionAvatarTypes";

/** One bounded download per session; replacement/removal invalidates old completions. */
export class SessionAvatarHydrator {
  private readonly pending = new Map<
    string,
    { descriptor: SessionAvatarDescriptor; controller: AbortController }
  >();

  constructor(
    private readonly options: {
      read: (
        id: string,
      ) =>
        | { avatarDescriptor?: SessionAvatarDescriptor | null; avatar?: ProjectAvatar | null }
        | undefined;
      load: (
        id: string,
        descriptor: SessionAvatarDescriptor,
        signal: AbortSignal,
      ) => Promise<ProjectAvatar | null>;
      publish: (id: string, avatar: ProjectAvatar) => void;
    },
  ) {}

  refresh(id: string): void {
    const current = this.options.read(id);
    const descriptor = current?.avatarDescriptor;
    const pending = this.pending.get(id);
    if (descriptor && sameSessionAvatar(descriptor, pending?.descriptor)) return;
    this.cancel(id);
    if (
      !descriptor ||
      (current?.avatar?.ref === descriptor.ref && current.avatar.version === descriptor.version)
    )
      return;
    const entry = { descriptor, controller: new AbortController() };
    this.pending.set(id, entry);
    const timer = setTimeout(() => entry.controller.abort(), 15_000);
    void this.options
      .load(id, descriptor, entry.controller.signal)
      .then((avatar) => {
        if (
          avatar &&
          !entry.controller.signal.aborted &&
          this.pending.get(id) === entry &&
          sameSessionAvatar(this.options.read(id)?.avatarDescriptor, descriptor)
        ) {
          this.options.publish(id, avatar);
        }
      })
      .catch(() => {
        /* Artwork failure must not interrupt session synchronization. */
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.pending.get(id) === entry) this.pending.delete(id);
      });
  }

  cancel(id: string): void {
    this.pending.get(id)?.controller.abort();
    this.pending.delete(id);
  }

  clear(): void {
    for (const id of this.pending.keys()) this.cancel(id);
  }
}
