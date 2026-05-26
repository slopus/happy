type TrackingClient = {
    capture: (event: string, properties?: Record<string, unknown>) => void;
    identify: (userId: string, properties?: Record<string, unknown>) => void;
    reset: () => void;
    screen: (name: string) => void;
    optIn: () => void;
    optOut: () => void;
    getFeatureFlag: (key: string) => unknown;
};

export const tracking: TrackingClient | null = null;
