import type { ActivitySnapshot } from './codexActivityCalendar';

/** Shared Web/native disclosure contract; data stays owned by the execution host. */
export interface CodexActivityHeatmapProps {
    snapshot: ActivitySnapshot | null;
    language: string;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
}
