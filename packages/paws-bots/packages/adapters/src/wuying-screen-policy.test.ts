import {
  COMPUTER_SCREEN_PATH,
  contentSecurityPolicyFor as selectPolicy,
} from "@rakazo/contracts/content-security-policy";
import { describe, expect, it } from "vitest";
import { wuyingScreenPolicy } from "./wuying-screen-policy.js";

const contentSecurityPolicyFor = (pathname: string) =>
  selectPolicy(pathname, undefined, wuyingScreenPolicy);
function directives(policy: string) {
  return new Map(
    policy.split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
}

describe("Wuying screen policy", () => {
  it("isolates Wuying documents without widening the app policy", () => {
    const screen = directives(contentSecurityPolicyFor(COMPUTER_SCREEN_PATH)!);
    expect(screen.get("sandbox")).toEqual(["allow-scripts", "allow-pointer-lock"]);
    expect(screen.get("frame-ancestors")).toEqual(["'self'"]);
    expect(screen.get("connect-src")).not.toContain("'self'");
    expect(screen.get("script-src")).not.toContain("'unsafe-eval'");
    expect(screen.get("script-src")).toContain("'wasm-unsafe-eval'");
    expect(screen.get("script-src")).not.toContain(
      "https://o.alicdn.com/aliyun-ecs/eds-cdn/paho-mqtt/mqttws31.min.js",
    );
    expect(screen.get("connect-src")).not.toContain("data:");
    expect(screen.get("connect-src")?.some((source) => source.endsWith(":*"))).toBe(false);
    expect(screen.get("script-src")).not.toContain("data:");
    const nested = directives(contentSecurityPolicyFor("/computer-screen/sdk/ASP/container.html")!);
    expect(nested.get("sandbox")).toEqual(screen.get("sandbox"));
    expect(nested.get("script-src")).toContain(
      "https://o.alicdn.com/aliyun-ecs/eds-cdn/paho-mqtt/mqttws31.min.js",
    );
    expect(nested.get("connect-src")).toEqual([
      ...screen.get("connect-src")!,
      "wss://*.wuying.aliyuncs.com:*",
      "data:",
    ]);
    expect(nested.get("frame-ancestors")).toBeUndefined();
    for (const path of [
      "/computer-screen/",
      "/computer-screen/screen.js",
      "/computer-screen/storage.js",
      "/computer-screen/other.html",
      "/computer-screen/sdk/ASP/container.html/",
      "/computer-screen/sdk/ASP/container.html.extra",
    ]) {
      const restricted = directives(contentSecurityPolicyFor(path)!);
      expect(restricted.get("frame-ancestors")).toEqual(["'self'"]);
      expect(restricted.get("sandbox")).toEqual(screen.get("sandbox"));
      expect(restricted.get("connect-src")).toEqual(screen.get("connect-src"));
    }
    expect(contentSecurityPolicyFor("/chat")).toBe(selectPolicy("/chat"));
  });
});
