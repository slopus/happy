import { useUpdates } from './useUpdates';

// The activity badge only signals an available app update.
export function useInboxHasContent(): boolean {
    return useUpdates().updateAvailable;
}
