type ChromeStorageValue = Record<string, unknown>;

declare const chrome: {
    runtime: {
        id: string;
        getURL(path: string): string;
    };
    storage: {
        local: {
            get(key: string): Promise<ChromeStorageValue>;
            set(items: ChromeStorageValue): Promise<void>;
            remove(key: string): Promise<void>;
        };
    };
};
