import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceForVersion, validateSources, validateThemePackage, versionFromThemeUrl } from './dreamskin-import-core.mjs';

const version = 'ver_ab667004dad5bfec326d';
const url = `https://www.dreamskin.cc/themes/${version}`;

test('accepts only a DreamSkin theme page and derives a stable internal ID', () => {
    assert.equal(versionFromThemeUrl(url), version);
    assert.equal(versionFromThemeUrl(url.replace('www.', '')), version);
    assert.deepEqual(sourceForVersion(version, 'a'.repeat(64)), {
        id: 'dsab667004dad5bfec326d', assetId: 'ds-ab667004dad5bfec326d',
        versionId: version, zipSha256: 'a'.repeat(64),
    });
    for (const invalid of [
        url.replace('https:', 'http:'),
        url.replace('dreamskin.cc', 'dreamskin.cc.evil.test'),
        `${url}?download=1`, `${url}#preview`, `${url}/extra`,
        'https://www.dreamskin.cc/themes/ver_short',
        'https://www.dreamskin.cc@evil.test/themes/ver_ab667004dad5bfec326d',
    ]) assert.throws(() => versionFromThemeUrl(invalid));
});

test('rejects duplicate source identities before generating catalog entries', () => {
    const spec = sourceForVersion(version, 'a'.repeat(64));
    assert.throws(() => validateSources([spec, { ...spec, versionId: 'ver_00000000000000000000' }]), /Duplicate/);
    assert.throws(() => validateSources([{ ...spec, assetId: '../escape' }]), /Invalid/);
});

test('rejects theme packages whose colors or image cannot be rendered safely', () => {
    const manifest = { packageVersion: 1, themeId: 'demo', publisher: { displayName: 'Demo' }, license: 'MIT', files: [
        { path: 'theme.json', bytes: 10, sha256: 'a'.repeat(64) },
        { path: 'background.webp', bytes: 10, sha256: 'b'.repeat(64) },
    ] };
    const theme = { schemaVersion: 1, id: 'demo', name: 'Demo', appearance: 'dark', image: 'background.webp',
        art: { focusX: 0.5, focusY: 0.5 }, colors: Object.fromEntries(
            ['background', 'panel', 'panelAlt', 'accent', 'accentAlt', 'secondary', 'highlight', 'text', 'muted', 'line'].map((key) => [key, '#123456']),
        ) };
    assert.doesNotThrow(() => validateThemePackage(manifest, theme, version));
    assert.throws(() => validateThemePackage(manifest, { ...theme, colors: { ...theme.colors, panel: 'var(--unsafe)' } }, version), /unsupported/);
    assert.throws(() => validateThemePackage(manifest, { ...theme, image: '../private.png' }, version), /unsupported/);
    assert.throws(() => validateThemePackage({ ...manifest, files: [{ ...manifest.files[0], path: '../private' }] }, theme, version), /unsupported/);
});
