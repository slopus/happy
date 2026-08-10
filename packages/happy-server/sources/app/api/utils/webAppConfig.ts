function serializeForInlineScript(value: Record<string, unknown>): string {
    return JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}

export const WEB_APP_CONFIG_PATH = "/happy-config.js";

export function createWebAppConfigSource(config: Record<string, unknown> = {}): string {
    const runtimeConfig = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    const serializedConfig = serializeForInlineScript(runtimeConfig);
    return `window.__HAPPY_CONFIG__=${serializedConfig};(function(){var raw=window.__HAPPY_CONFIG__.serverUrl;var valid=false;if(typeof raw==="string"&&raw.trim()){try{var parsed=new URL(raw.trim());valid=parsed.protocol==="http:"||parsed.protocol==="https:";}catch(_){}}window.__HAPPY_CONFIG__.serverUrl=valid?raw.trim():window.location.origin;})();`;
}

export function createWebAppConfigScript(): string {
    // An external same-origin script works with the common `script-src 'self'`
    // reverse-proxy CSP. An inline script would be blocked and make the bundled
    // app silently fall back to the hosted cloud API again.
    return `<script src="${WEB_APP_CONFIG_PATH}"></script>`;
}

export function injectWebAppConfig(html: string): string {
    const script = createWebAppConfigScript();
    return html.replace(/<head[^>]*>/i, (head) => `${head}\n${script}`);
}

export function isWebAppIndexRequest(url: string): boolean {
    const pathname = url.split("?", 1)[0];
    return pathname === "/" || pathname === "/index.html";
}
