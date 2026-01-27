import { ApiEphemeralUpdateSchema } from '../apiTypes';

export function parseEphemeralUpdate(update: unknown): any | null {
    const validatedUpdate = ApiEphemeralUpdateSchema.safeParse(update);
    if (!validatedUpdate.success) {
        console.error('Invalid ephemeral update received:', update);
        return null;
    }
    return validatedUpdate.data;
}

