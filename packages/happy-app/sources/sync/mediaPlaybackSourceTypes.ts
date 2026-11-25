export type MediaPlaybackSource = {
    uri: string;
    headers: Record<string, string>;
    reuseKey?: string;
    isCurrent?: () => boolean;
    refreshSource?: () => Promise<MediaPlaybackSource>;
    release?: () => void | Promise<void>;
    /** Borrow the same native file without deleting it while another consumer uses it. */
    retain?: () => MediaPlaybackSource;
};
