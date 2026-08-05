export type MediaPlaybackSource = {
    uri: string;
    headers: Record<string, string>;
    release?: () => void | Promise<void>;
};
