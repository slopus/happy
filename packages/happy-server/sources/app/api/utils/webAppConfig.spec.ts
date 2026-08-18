import { describe, expect, it } from "vitest";
import {
    createWebAppConfigScript,
    createWebAppConfigSource,
    injectWebAppConfig,
    isWebAppIndexRequest,
    WEB_APP_CONFIG_PATH,
} from "./webAppConfig";

function runConfigScript(source: string, origin: string): Record<string, unknown> {
    const browser = { location: { origin } } as { location: { origin: string }; __HAPPY_CONFIG__?: Record<string, unknown> };
    new Function("window", "URL", source)(browser, URL);
    return browser.__HAPPY_CONFIG__!;
}

describe("self-hosted web app config", () => {
    it("defaults the API URL to the browser origin", () => {
        const script = createWebAppConfigSource();

        expect(runConfigScript(script, "https://happy.example.com")).toEqual({
            serverUrl: "https://happy.example.com",
        });
    });

    it("preserves an explicit server URL and other runtime config", () => {
        const script = createWebAppConfigSource({
            serverUrl: "https://api.example.com",
            disableAnalytics: true,
        });

        expect(runConfigScript(script, "https://web.example.com")).toEqual({
            serverUrl: "https://api.example.com",
            disableAnalytics: true,
        });
    });

    it("falls back to the browser origin for an invalid override", () => {
        const script = createWebAppConfigSource({ serverUrl: "   " });

        expect(runConfigScript(script, "https://happy.example.com").serverUrl).toBe("https://happy.example.com");
    });

    it("loads runtime config from a same-origin external script", () => {
        const html = "<!doctype html><html><head><title>Happy</title></head><body></body></html>";
        const injected = injectWebAppConfig(html);

        expect(injected).toContain(`<head>\n<script src="${WEB_APP_CONFIG_PATH}"></script>`);
        expect(createWebAppConfigScript()).not.toContain("window.__HAPPY_CONFIG__");
    });

    it("serializes hostile config without emitting a literal script terminator", () => {
        const source = createWebAppConfigSource({ label: "</script><script>alert(1)</script>" });

        expect(source).not.toContain("</script><script>alert(1)</script>");
        expect(source).toContain("\\u003c/script>");
    });

    it.each(["javascript:alert(1)", "data:text/plain,nope", "not a URL"])(
        "falls back to same-origin for invalid server URL %j",
        (serverUrl) => {
            const source = createWebAppConfigSource({ serverUrl });
            expect(runConfigScript(source, "https://happy.example.com").serverUrl)
                .toBe("https://happy.example.com");
        },
    );

    it("recognizes direct index requests with or without a query string", () => {
        expect(isWebAppIndexRequest("/")).toBe(true);
        expect(isWebAppIndexRequest("/?cache=1")).toBe(true);
        expect(isWebAppIndexRequest("/index.html")).toBe(true);
        expect(isWebAppIndexRequest("/index.html?cache=1")).toBe(true);
        expect(isWebAppIndexRequest("/assets/index.html")).toBe(false);
    });
});
