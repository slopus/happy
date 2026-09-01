import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function valuesOf(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function ruleCoversWebReads(rule, origin) {
    const origins = valuesOf(rule?.AllowedOrigin);
    const methods = new Set(valuesOf(rule?.AllowedMethod).map((method) => String(method).toUpperCase()));
    return (origins.includes('*') || origins.includes(origin))
        && methods.has('GET')
        && methods.has('HEAD');
}

export function mergeWebOssCors(current, origin) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        throw new Error('Current OSS CORS configuration must be a JSON object.');
    }
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin) {
        throw new Error(`Web CORS origin must be one canonical HTTPS origin: ${origin}`);
    }

    const originalRules = current.CORSRule === undefined
        ? []
        : Array.isArray(current.CORSRule)
            ? current.CORSRule
            : [current.CORSRule];
    if (originalRules.some((rule) => ruleCoversWebReads(rule, origin))) {
        return { changed: false, configuration: current };
    }

    const webRule = {
        AllowedOrigin: [origin],
        AllowedMethod: ['GET', 'HEAD'],
        AllowedHeader: '*',
        ExposeHeader: ['ETag'],
        MaxAgeSeconds: 600,
    };
    const rules = [...originalRules, webRule];
    return {
        changed: true,
        configuration: {
            ...current,
            CORSRule: rules.length === 1 ? rules[0] : rules,
        },
    };
}

async function main() {
    const [inputPath, outputPath, origin] = process.argv.slice(2);
    if (!inputPath || !outputPath || !origin) {
        throw new Error('Usage: node scripts/merge-web-oss-cors.mjs <current.json> <merged.json> <https-origin>');
    }
    const current = JSON.parse(await readFile(inputPath, 'utf8'));
    const result = mergeWebOssCors(current, origin);
    await writeFile(outputPath, `${JSON.stringify(result.configuration, null, 2)}\n`, 'utf8');
    process.stdout.write(result.changed ? 'changed\n' : 'unchanged\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
