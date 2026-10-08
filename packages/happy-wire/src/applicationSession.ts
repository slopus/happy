import { z } from 'zod';
const identifier = z.string().min(1).max(256).refine(value => value.trim().length > 0);
export const ApplicationSessionMetadataSchema = z.object({ appId: identifier, bindingId: identifier }).strict();
export type ApplicationSessionMetadata = z.infer<typeof ApplicationSessionMetadataSchema>;
/** Provenance is explicit metadata; paths and titles never classify a session. */
export function isApplicationSession(metadata: unknown): metadata is { application: ApplicationSessionMetadata } {
    return !!metadata && typeof metadata === 'object' && ApplicationSessionMetadataSchema.safeParse((metadata as Record<string, unknown>).application).success;
}
