const VERSION_ID = /^ver_[0-9a-f]{20}$/;
const HASH = /^[0-9a-f]{64}$/;

export function versionFromThemeUrl(input) {
    let url;
    try { url = new URL(input); } catch { throw new Error(`Invalid DreamSkin theme URL: ${input}`); }
    const versionId = url.pathname.slice('/themes/'.length);
    if (url.protocol !== 'https:' || !['dreamskin.cc', 'www.dreamskin.cc'].includes(url.hostname)
        || url.port || url.username || url.password || url.search || url.hash
        || url.pathname !== `/themes/${versionId}` || !VERSION_ID.test(versionId)) {
        throw new Error(`Expected https://www.dreamskin.cc/themes/ver_<20 hex digits>: ${input}`);
    }
    return versionId;
}

export function sourceForVersion(versionId, zipSha256) {
    if (!VERSION_ID.test(versionId) || !HASH.test(zipSha256)) throw new Error('Invalid DreamSkin source');
    const suffix = versionId.slice(4);
    return { id: `ds${suffix}`, assetId: `ds-${suffix}`, versionId, zipSha256 };
}

export function validateSources(sources) {
    if (!Array.isArray(sources)) throw new Error('DreamSkin source registry must be an array');
    const ids = new Set(), assets = new Set(), versions = new Set();
    for (const spec of sources) {
        if (!spec || typeof spec !== 'object' || !/^[a-z][a-zA-Z0-9]*$/.test(spec.id)
            || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(spec.assetId)
            || !VERSION_ID.test(spec.versionId) || !HASH.test(spec.zipSha256)) {
            throw new Error(`Invalid DreamSkin source: ${JSON.stringify(spec)}`);
        }
        if (ids.has(spec.id) || assets.has(spec.assetId) || versions.has(spec.versionId)) {
            throw new Error(`Duplicate DreamSkin source: ${spec.versionId}`);
        }
        ids.add(spec.id); assets.add(spec.assetId); versions.add(spec.versionId);
    }
    return sources;
}

export function validateThemePackage(manifest, theme, versionId) {
    const color = /^(?:#[0-9a-f]{6}|rgba?\(\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?))?\s*\))$/i;
    const requiredColors = ['background', 'panel', 'panelAlt', 'accent', 'accentAlt', 'secondary', 'highlight', 'text', 'muted', 'line'];
    if (manifest?.packageVersion !== 1 || theme?.schemaVersion !== 1 || manifest.themeId !== theme.id
        || !['light', 'dark'].includes(theme.appearance)
        || typeof theme.name !== 'string' || !theme.name.trim()
        || typeof manifest.publisher?.displayName !== 'string' || !manifest.publisher.displayName.trim()
        || typeof manifest.license !== 'string' || !manifest.license.trim()
        || !/^background\.(?:png|jpe?g|webp)$/.test(theme.image)
        || !Number.isFinite(theme.art?.focusX) || theme.art.focusX < 0 || theme.art.focusX > 1
        || !Number.isFinite(theme.art?.focusY) || theme.art.focusY < 0 || theme.art.focusY > 1
        || !requiredColors.every((key) => typeof theme.colors?.[key] === 'string' && color.test(theme.colors[key]))
        || !Array.isArray(manifest.files)
        || !['theme.json', theme.image].every((path) => manifest.files.some((file) => file.path === path))) {
        throw new Error(`${versionId}: unsupported theme package`);
    }
    for (const file of manifest.files) {
        if (!/^[a-z][a-z0-9.]*$/i.test(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HASH.test(file.sha256)) {
            throw new Error(`${versionId}: invalid package manifest`);
        }
    }
}
