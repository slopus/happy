import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const PROJECT_CANVAS_APPROVED_ORIGINS = Object.freeze(['https://47.115.228.20:8443', 'https://121.43.32.242:8443']);

export const RUNTIME_CONFIG_START = '<!-- paws-web-runtime-server-config:start -->';
export const RUNTIME_CONFIG_END = '<!-- paws-web-runtime-server-config:end -->';

function projectCanvasConfig(origins, revision, license, evaluationExpiry) {
    if (!Array.isArray(origins) || !origins.length || origins.some(origin => !PROJECT_CANVAS_APPROVED_ORIGINS.includes(origin))) {
        throw new Error('Expected an approved exact Project Canvas origin.');
    }
    if (!/^[0-9a-f]{40}$/.test(revision ?? '')) {
        throw new Error('Project Canvas requires a full release revision.');
    }
    if (typeof license !== 'string' || !license.trim() || license.length > 4096) {
        throw new Error('Missing or malformed PAWS_PROJECT_CANVAS_TLDRAW_LICENSE.');
    }
    let expiresAt;
    if (evaluationExpiry) {
        expiresAt = Number(evaluationExpiry);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
            throw new Error('Invalid Project Canvas evaluation expiry.');
        }
    }
    const options = JSON.stringify({
        projectCanvasTldrawLicense: license.trim(),
        projectCanvasTldrawExpiresAt: expiresAt,
    }).replaceAll('<', '\\u003c');
    const entry = `/dsh-image-canvas/${revision}/index.html`;
    return {
        markup: `<meta name="paws-project-canvas-entry" content="${entry}">`,
        script: `if(${JSON.stringify([...new Set(origins)])}.includes(l.origin))Object.assign(globalThis.__HAPPY_CONFIG__,${options});`,
    };
}

export function injectWebRuntimeServerConfig(html, canvas) {
    const { markup = '', script = '' } = canvas
        ? projectCanvasConfig(canvas.origins ?? [canvas.origin], canvas.revision, canvas.license, canvas.evaluationExpiry)
        : {};
    const managed = `${RUNTIME_CONFIG_START}${markup}<script>(function(){var l=globalThis.location;if(!l||l.protocol!=="https:"||!["app.paws.rodeo","paws.rodeo","47.115.228.20","121.43.32.242"].includes(l.hostname))return;globalThis.__HAPPY_CONFIG__=Object.assign({},globalThis.__HAPPY_CONFIG__,{serverUrl:l.origin});${script}})();</script>${RUNTIME_CONFIG_END}`;
    const startCount = html.split(RUNTIME_CONFIG_START).length - 1;
    const endCount = html.split(RUNTIME_CONFIG_END).length - 1;

    if (startCount !== endCount || startCount > 1) {
        throw new Error('Web entry has an incomplete managed runtime configuration block.');
    }
    if (startCount === 1) {
        const start = html.indexOf(RUNTIME_CONFIG_START);
        const end = html.indexOf(RUNTIME_CONFIG_END, start);
        if (end < start) {
            throw new Error('Web entry has an incomplete managed runtime configuration block.');
        }
        return `${html.slice(0, start)}${managed}${html.slice(end + RUNTIME_CONFIG_END.length)}`;
    }

    const headEnd = html.search(/<\/head\s*>/i);
    if (headEnd < 0) {
        throw new Error('Web entry has no </head>.');
    }
    return `${html.slice(0, headEnd)}${managed}${html.slice(headEnd)}`;
}

async function main() {
    const [indexPath, ...canvasArgs] = process.argv.slice(2);
    if (!indexPath) {
        throw new Error('Usage: node scripts/inject-web-runtime-server-config.mjs <index.html> [--project-canvas|--check-project-canvas <origin[,origin]> <revision>]');
    }
    if (canvasArgs.length && (canvasArgs.length !== 3 || !['--project-canvas', '--check-project-canvas'].includes(canvasArgs[0]))) {
        throw new Error('Expected a Project Canvas option, origin, and revision.');
    }
    const canvas = canvasArgs.length ? {
        origins: canvasArgs[1].split(','),
        revision: canvasArgs[2],
        license: process.env.PAWS_PROJECT_CANVAS_TLDRAW_LICENSE,
        evaluationExpiry: process.env.PAWS_PROJECT_CANVAS_TLDRAW_EXPIRES_AT,
    } : undefined;
    const source = await readFile(indexPath, 'utf8');
    const configured = injectWebRuntimeServerConfig(source, canvas);
    if (canvasArgs[0] === '--check-project-canvas') {
        if (source !== configured) throw new Error('The stamped Project Canvas configuration does not match this release.');
    } else {
        await writeFile(indexPath, configured, 'utf8');
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await main();
}
