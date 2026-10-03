import * as semver from 'semver';

const repository = 'https://github.com/wangjs-jacky/happy';
type Channel = 'production' | 'preview';
export type NativeRelease = { channel: Channel; version: string; runtime: number; url: string; releaseUrl: string };
export type NativeReleaseCatalog = NativeRelease[] & { unavailableChannels?: Channel[] };
type Candidate = NativeRelease & { name: string; size: number; sha256: string; verificationUrl: string };
type Asset = { name?: unknown; state?: unknown; size?: unknown; digest?: unknown; browser_download_url?: unknown };
type Release = { tag_name?: unknown; target_commitish?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown; assets?: Asset[] };

function selectReleases(raw: unknown): Candidate[] {
    if (!Array.isArray(raw)) throw new Error('Invalid GitHub release response');
    return raw.flatMap((release: Release) => {
        if (!release || release.draft !== false || release.prerelease !== false || !release.published_at
            || typeof release.tag_name !== 'string' || !/^android-[A-Za-z0-9._-]+$/.test(release.tag_name)
            || typeof release.target_commitish !== 'string' || !/^[a-f0-9]{40}$/.test(release.target_commitish)
            || !Array.isArray(release.assets)) return [];
        const tag = release.tag_name;
        return release.assets.flatMap(asset => {
            if (!asset || typeof asset.name !== 'string') return [];
            const match = /^paws-(production|preview)-v(\d+\.\d+\.\d+)-runtime(\d+)-([a-f0-9]{7,40})-arm64\.apk$/.exec(asset.name);
            if (!match || !semver.valid(match[2]) || asset.state !== 'uploaded'
                || typeof asset.size !== 'number' || asset.size <= 0
                || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) return [];
            const url = `${repository}/releases/download/${tag}/${asset.name}`;
            const runtime = Number(match[3]);
            if (asset.browser_download_url !== url || !Number.isSafeInteger(runtime) || runtime <= 0) return [];
            if (!(release.target_commitish as string).startsWith(match[4]) || !tag.endsWith(`-${match[4]}`)) return [];
            const sidecars = release.assets!.filter(a => a.name === asset.name + '.verification.json');
            const sidecar = sidecars[0];
            if (sidecars.length !== 1 || sidecar.state !== 'uploaded' || typeof sidecar.size !== 'number'
                || sidecar.size <= 0 || sidecar.size > 16_384
                || sidecar.browser_download_url !== url + '.verification.json') return [];
            return [{ channel: match[1] as Channel, version: match[2], runtime, url,
                releaseUrl: `${repository}/releases/tag/${tag}`, name: asset.name, size: asset.size,
                sha256: asset.digest.slice(7), verificationUrl: sidecar.browser_download_url }];
        });
    });
}

// One cache and one in-flight request per server, not per phone/channel. A
// refresh failure may reuse a previously verified catalog during the short
// cooldown; without verified data it remains unknown, never "up to date".
export function createNativeReleaseCatalog() {
    let cache: NativeReleaseCatalog | undefined;
    let expiresAt = 0;
    let staleUntil = 0;
    let retryAt = 0;
    let pending: Promise<NativeReleaseCatalog> | undefined;
    return async (): Promise<NativeReleaseCatalog> => {
        if (cache && Date.now() < expiresAt) return cache;
        if (pending) return pending;
        if (Date.now() < retryAt) {
            if (cache && Date.now() < staleUntil) return cache;
            throw new Error('Release check temporarily unavailable');
        }
        pending = (async () => {
            const releases: Candidate[] = [];
            const releaseSignal = AbortSignal.timeout(8000);
            // CLI and Android share this repository; /releases/latest is a CLI
            // release. Scan bounded pages, stopping once both APK channels exist.
            for (let page = 1; page <= 3; page++) {
                const response = await fetch(`https://api.github.com/repos/wangjs-jacky/happy/releases?per_page=100&page=${page}`, {
                    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Paws-native-updates' },
                    // Monorepo Node/RN ambient types disagree on AbortSignal;
                    // the runtime object is the standard Node abort signal.
                    signal: releaseSignal as never,
                });
                if (!response.ok) throw new Error(`GitHub release check failed: ${response.status}`);
                const raw: unknown = await response.json();
                releases.push(...selectReleases(raw));
                if ((Array.isArray(raw) && raw.length < 100)
                    || ['production', 'preview'].every(channel => releases.some(r => r.channel === channel))) break;
            }
            const verified: NativeReleaseCatalog = [];
            const failedCandidates: Candidate[] = [];
            // A bounded catalog of recent APKs; equal version/runtime candidates
            // must be unambiguous. Never choose by GitHub asset array order.
            const tuple = (r: Candidate) => `${r.channel}:${r.runtime}:${r.version}`;
            const counts = new Map<string, number>();
            for (const release of releases) counts.set(tuple(release), (counts.get(tuple(release)) ?? 0) + 1);
            const candidates = (['production', 'preview'] as const).flatMap(channel => releases
                .filter(r => r.channel === channel && counts.get(tuple(r)) === 1)
                .sort((a, b) => b.runtime - a.runtime || semver.rcompare(a.version, b.version)).slice(0, 16));
            // Run bounded sidecars concurrently so an unavailable channel cannot
            // consume the entire deadline before the other channel is checked.
            const verificationSignal = AbortSignal.timeout(8000);
            await Promise.all(candidates.map(async candidate => {
                try {
                    const response = await fetch(candidate.verificationUrl, { signal: verificationSignal as never });
                    if (!response.ok) throw new Error('APK verification metadata unavailable');
                    const text = await response.text();
                    if (text.length > 16_384) throw new Error('APK verification metadata too large');
                    const metadata = JSON.parse(text);
                    const expectedPackage = candidate.channel === 'production' ? 'build.paws' : 'build.paws.preview';
                    if (metadata?.apk !== candidate.name || metadata.variant !== candidate.channel
                        || metadata.package !== expectedPackage || metadata.channel !== candidate.channel
                        || metadata.runtimeVersion !== String(candidate.runtime) || metadata.version !== candidate.version
                        || metadata.size !== candidate.size || metadata.sha256 !== candidate.sha256
                        || metadata.zipValid !== true || metadata.signatureV2Valid !== true || metadata.bluetoothUncapped !== true
                        || !Array.isArray(metadata.abis) || metadata.abis.length !== 1 || metadata.abis[0] !== 'arm64-v8a') return;
                    verified.push(candidate);
                } catch { failedCandidates.push(candidate); }
            }));
            // A verified APK covers failed lookups at or below both its runtime
            // and version in the same channel. Older sidecar timeouts must not
            // invalidate checking the current APK; potentially newer ones do.
            const unavailableChannels = new Set(failedCandidates.filter(candidate => !verified.some(release =>
                release.channel === candidate.channel && release.runtime >= candidate.runtime
                && semver.gte(release.version, candidate.version))).map(candidate => candidate.channel));
            if (unavailableChannels.size && !verified.length) throw new Error('APK verification metadata unavailable');
            if (unavailableChannels.size) verified.unavailableChannels = [...unavailableChannels];
            cache = verified;
            expiresAt = Date.now() + (unavailableChannels.size ? 30_000 : 10 * 60_000);
            staleUntil = Date.now() + 60 * 60_000;
            return verified;
        })().catch(error => {
            retryAt = Date.now() + 30_000;
            if (cache && Date.now() < staleUntil) return cache;
            throw error;
        }).finally(() => { pending = undefined; });
        return pending;
    };
}

export function newestNativeRelease(releases: NativeRelease[], channel: Channel, current: { runtime: number; version: string }): NativeRelease | undefined {
    return releases.filter(r => r.channel === channel && r.runtime >= current.runtime && semver.gte(r.version, current.version)).sort((a, b) =>
        b.runtime - a.runtime || semver.rcompare(a.version, b.version))[0];
}
