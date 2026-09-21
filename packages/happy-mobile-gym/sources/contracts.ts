/** Safe to print or give to a desktop recorder. No tokens, keys, or auth URLs. */
export interface MobileGymManifest {
    readonly version: 1;
    readonly kind: 'happy-mobile-gym';
    readonly runId: string;
    readonly owner: string;
    readonly createdAt: string;
    readonly runRoot: string;
    readonly repositoryRoot: string;
    readonly source: {
        readonly commit: string;
        readonly trackedDiffSha256: string;
        readonly dirty: boolean;
    };
    readonly server: { readonly port: number; readonly url: string };
    readonly metro: { readonly port: number; readonly url: string };
    readonly paths: {
        readonly manifest: string;
        readonly credentials: string;
        readonly database: string;
        readonly serverLog: string;
        readonly metroLog: string;
        readonly migrationLog: string;
    };
}

export interface MobileGymCreateOptions {
    readonly repositoryRoot: string;
    /** Human-readable owner/purpose, e.g. "desktop core recording". */
    readonly owner: string;
    readonly serverPort: number;
    readonly metroPort: number;
}

export type MobileGymCompletion =
    | { readonly reason: 'stopped' }
    | { readonly reason: 'failed'; readonly message: string };

export interface MobileGymRunning {
    /** Returned only after both endpoints are ready and real account auth works. */
    readonly manifest: MobileGymManifest;
    readonly finished: Promise<MobileGymCompletion>;
    /** Idempotent; stops only this controller's children, retains all run data. */
    stop(): Promise<void>;
}

export interface MobileGymStatus {
    readonly manifest: MobileGymManifest;
    /** A lock is evidence of ownership, not proof of liveness/readiness. */
    readonly controllerLockPresent: boolean;
    readonly credentialsPresent: boolean;
}