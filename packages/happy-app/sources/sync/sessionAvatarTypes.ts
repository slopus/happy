import { z } from "zod";

export const sessionAvatarDescriptorSchema = z.object({
  ref: z.string().min(1).max(1024),
  preview: z.string().min(1).max(4096),
  version: z.number().int().positive(),
});
export type SessionAvatarDescriptor = z.infer<typeof sessionAvatarDescriptorSchema>;
export const sessionAvatarRevisionSchema = z.number().int().nonnegative();

export function sameSessionAvatar(
  a: SessionAvatarDescriptor | null | undefined,
  b: SessionAvatarDescriptor | null | undefined,
): boolean {
  return (
    a === b || (!!a && !!b && a.ref === b.ref && a.version === b.version && a.preview === b.preview)
  );
}
