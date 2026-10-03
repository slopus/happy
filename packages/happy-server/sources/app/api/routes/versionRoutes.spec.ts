import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { versionRoutes } from '@/app/api/routes/versionRoutes';

const tag = 'android-v1.7.1-runtimes23-24-3906949b';
const apk = (variant: string, runtime: number) => {
    const name = `paws-${variant}-v1.7.1-runtime${runtime}-3906949b-arm64.apk`;
    return { name, state: 'uploaded', size: 150830486, digest: `sha256:${'a'.repeat(64)}`,
        browser_download_url: `https://github.com/wangjs-jacky/happy/releases/download/${tag}/${name}` };
};
const release = () => ({ tag_name: tag, draft: false, prerelease: false,
    target_commitish: '3906949b26293701d16d2c159eb6faaac081a1a2',
    published_at: '2026-09-05T19:48:00Z', html_url: `https://github.com/wangjs-jacky/happy/releases/tag/${tag}`,
    assets: [apk('production', 24), apk('preview', 23), ...[apk('production', 24), apk('preview', 23)].map(a =>
        ({ ...a, name: a.name + '.verification.json', size: 500, browser_download_url: a.browser_download_url + '.verification.json' }))] });

async function check(payload: Record<string, unknown>, releases: unknown[] = [release()], status = 200, metadataOverride = {}, failPreview = false, failSidecar?: RegExp) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(releases), { status });
        if (failPreview && url.includes('paws-preview-')) return new Response('unavailable', { status: 404 });
        if (failSidecar?.test(url)) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        const variant = url.includes('paws-production-') ? 'production' : 'preview';
        const asset = apk(variant, variant === 'production' ? 24 : 23);
        const filename = url.split('/').pop()!.replace(/\.verification\.json$/, '');
        const version = /-v(\d+\.\d+\.\d+)-runtime(\d+)-/.exec(filename)!;
        return new Response(JSON.stringify({ apk: filename, variant, package: variant === 'production' ? 'build.paws' : 'build.paws.preview',
            channel: variant, runtimeVersion: version[2], version: version[1],
            size: asset.size, sha256: 'a'.repeat(64), abis: ['arm64-v8a'], zipValid: true,
            signatureV2Valid: true, bluetoothUncapped: true, ...metadataOverride }));
    }));
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    versionRoutes(app);
    const result = await app.inject({ method: 'POST', url: '/v1/version', payload });
    await app.close();
    return { status: result.statusCode, body: result.json() };
}
const production = { platform: 'android', version: '1.7.1', app_id: 'build.paws', channel: 'production', runtime_version: '23' };
afterEach(() => vi.unstubAllGlobals());

describe('native APK upgrade contract', () => {
    it('offers the production GitHub APK across runtimes even when both versions are 1.7.1', async () => {
        const { body } = await check(production);
        expect(body).toMatchObject({ status: 'update-available', update_required: true,
            update_url: apk('production', 24).browser_download_url,
            updateUrl: apk('production', 24).browser_download_url, runtime_version: '24' });
    });
    it('keeps preview isolated from the larger production runtime', async () => {
        const { body } = await check({ ...production, app_id: 'build.paws.preview', channel: 'preview', runtime_version: '22' });
        expect(body.update_url).toBe(apk('preview', 23).browser_download_url);
    });
    it.each(['24', '25'])('does not prompt current/newer production runtime %s to downgrade', async runtime_version => {
        const { body } = await check({ ...production, runtime_version });
        expect(body).toMatchObject({ status: 'up-to-date', update_required: false, update_url: null });
    });
    it('does not infer native runtime from the unchanged display version of legacy requests', async () => {
        const { body } = await check({ platform: 'android', version: '1.7.1', app_id: 'build.paws' });
        expect(body).toMatchObject({ status: 'unknown', update_required: false, updateUrl: null });
    });
    it.each([
        { app_id: 'build.paws', channel: 'preview' },
        { app_id: 'build.paws.dev', channel: 'preview' },
        { app_id: 'com.ex3ndr.happy', channel: 'production' },
        { platform: 'ios' },
    ])('never sends incompatible installations to an APK or upstream store: %j', async fields => {
        const { body } = await check({ ...production, ...fields });
        expect(body).toMatchObject({ status: 'unsupported', updateUrl: null, update_url: null });
    });
    it('ignores CLI releases and unpublished APK releases', async () => {
        const { body } = await check(production, [{ ...release(), tag_name: 'cli-v9.0.0' }, { ...release(), draft: true }]);
        expect(body.status).toBe('unknown');
        expect(body.update_url).toBeNull();
    });
    it('does not advertise missing, incomplete or untrusted assets', async () => {
        const bad = release();
        bad.assets[0].browser_download_url = 'https://example.com/evil.apk';
        const { body } = await check(production, [bad]);
        expect(body.status).toBe('unknown');
        expect(body.update_url).toBeNull();
    });
    it('does not misreport an upstream outage as up to date', async () => {
        const { status, body } = await check(production, [], 503);
        expect(status).toBe(503);
        expect(body.status).toBe('unknown');
    });
    it('does not downgrade the app version just to obtain a larger runtime', async () => {
        const { body } = await check({ ...production, version: '1.8.0' });
        expect(body.update_required).toBe(false);
    });
    it('rejects verification metadata for the wrong package', async () => {
        const { body } = await check(production, [release()], 200, { package: 'build.paws.preview' });
        expect(body.status).toBe('unknown');
        expect(body.update_url).toBeNull();
    });
    it('rejects APKs without a published verification sidecar', async () => {
        const r = release();
        r.assets = r.assets.slice(0, 2);
        expect((await check(production, [r])).body.status).toBe('unknown');
    });
    it('rejects conflicting assets at the same version and runtime', async () => {
        const r = release();
        r.assets.push({ ...r.assets[0], digest: `sha256:${'b'.repeat(64)}` });
        expect((await check(production, [r])).body.status).toBe('unknown');
    });
    it('rejects an APK SHA label that does not match the release target', async () => {
        expect((await check(production, [{ ...release(), target_commitish: 'f'.repeat(40) }])).body.status).toBe('unknown');
    });
    it('still finds a safe upgrade when the highest runtime release has a lower app version', async () => {
        const incompatible = JSON.parse(JSON.stringify(release()).replace(/v1\.7\.1/g, 'v1.7.0').replace(/runtime24/g, 'runtime25'));
        const { body } = await check(production, [incompatible, release()]);
        expect(body.update_url).toBe(apk('production', 24).browser_download_url);
    });
    it('does not let production candidates crowd preview out of the bounded catalog', async () => {
        const crowded = release();
        crowded.assets = [];
        for (let runtime = 30; runtime < 46; runtime++) {
            const asset = apk('production', runtime);
            crowded.assets.push(asset, { ...asset, name: asset.name + '.verification.json', size: 500,
                browser_download_url: asset.browser_download_url + '.verification.json' });
        }
        const { body } = await check({ ...production, app_id: 'build.paws.preview', channel: 'preview', runtime_version: '22' }, [crowded, release()]);
        expect(body.update_url).toBe(apk('preview', 23).browser_download_url);
    });
    it('rejects only the ambiguous tuple, not a newer unique release in the same channel', async () => {
        const older = JSON.parse(JSON.stringify(release()).replace(/runtime24/g, 'runtime22'));
        expect((await check(production, [release(), older, older])).body.update_url).toBe(apk('production', 24).browser_download_url);
    });
    it('detects ambiguity before the per-channel candidate limit', async () => {
        const candidates = release();
        candidates.assets = [];
        for (let runtime = 25; runtime < 40; runtime++) {
            const asset = apk('production', runtime);
            candidates.assets.push(asset, { ...asset, name: asset.name + '.verification.json', size: 500,
                browser_download_url: asset.browser_download_url + '.verification.json' });
        }
        const duplicated = release();
        duplicated.assets.push({ ...duplicated.assets[0] });
        // Higher-runtime candidates are older semver, so only the duplicate at
        // positions 16/17 could otherwise be incorrectly offered to this phone.
        const older = JSON.parse(JSON.stringify(candidates).replace(/v1\.7\.1/g, 'v1.7.0'));
        expect((await check(production, [older, duplicated])).body.update_url).toBeNull();
    });
    it('isolates a failed preview sidecar from a verified production APK', async () => {
        expect((await check(production, [release()], 200, {}, true)).body.update_url).toBe(apk('production', 24).browser_download_url);
        const preview = { ...production, app_id: 'build.paws.preview', channel: 'preview', runtime_version: '22' };
        const result = await check(preview, [release()], 200, {}, true);
        expect(result.status).toBe(503);
        expect(result.body.status).toBe('unknown');
    });
    it.each([
        { app_id: 'build.paws', channel: 'production', runtime_version: '24' },
        { app_id: 'build.paws.preview', channel: 'preview', runtime_version: '23' },
    ])('does not let an older sidecar timeout invalidate the verified current APK: %j', async identity => {
        const older = JSON.parse(JSON.stringify(release()).replace(/runtime24/g, 'runtime22').replace(/runtime23/g, 'runtime21'));
        const result = await check({ ...production, ...identity }, [release(), older], 200, {}, false, /runtime2[12]-/);
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ status: 'up-to-date', update_required: false, update_url: null });
    });
    it.each([
        { label: 'higher runtime', newer: () => JSON.parse(JSON.stringify(release()).replace(/runtime24/g, 'runtime25')), failure: /paws-production-.*runtime25-/ },
        { label: 'higher version', newer: () => JSON.parse(JSON.stringify(release()).replace(/v1\.7\.1/g, 'v1.8.0')), failure: /paws-production-v1\.8\.0-/ },
    ])('still reports unknown when a $label APK cannot be verified', async ({ newer, failure }) => {
        const result = await check({ ...production, runtime_version: '24' }, [release(), newer()], 200, {}, false, failure);
        expect(result.status).toBe(503);
        expect(result.body).toMatchObject({ status: 'unknown', update_required: false, update_url: null });
    });
    it('requires the verified APK to cover both the failed runtime and version', async () => {
        const higherRuntime = JSON.parse(JSON.stringify(release()).replace(/runtime24/g, 'runtime25'));
        const higherVersion = JSON.parse(JSON.stringify(release()).replace(/v1\.7\.1/g, 'v1.8.0'));
        const result = await check({ ...production, runtime_version: '25' }, [higherRuntime, higherVersion], 200, {}, false, /paws-production-v1\.8\.0-/);
        expect(result.status).toBe(503);
        expect(result.body.status).toBe('unknown');
    });
    it.each([{ zipValid: false }, { signatureV2Valid: false }, { bluetoothUncapped: false }, { abis: ['x86_64'] }])(
        'rejects explicitly failed APK verification: %j', async metadata => {
            expect((await check(production, [release()], 200, metadata)).body.status).toBe('unknown');
        });
});
