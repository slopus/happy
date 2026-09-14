/** Session artwork uses the same opaque encrypted descriptor as project artwork. */
export type SessionAvatar = { ref: string; preview: string; version: number };

export function sessionAvatar(session: {
  avatarRef?: string | null;
  avatarPreview?: string | null;
  avatarVersion?: number;
}): SessionAvatar | null {
  return session.avatarRef && session.avatarPreview
    ? {
        ref: session.avatarRef,
        preview: session.avatarPreview,
        version: session.avatarVersion ?? 0,
      }
    : null;
}
