import type { EmbeddedComputerScreenPolicy } from "@rakazo/contracts/content-security-policy";

function serialize(directives: Record<string, string[]>) {
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

// The vendor runs only in opaque frames, including if this page is opened directly.
// No app-origin fetches, forms, objects or top-level navigation. Inline hashes cover only
// the pinned container's focus guard, version marker and click listener.
const WUYING_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'none'"],
  sandbox: ["allow-scripts", "allow-pointer-lock"],
  "script-src": [
    "'self'",
    "'wasm-unsafe-eval'",
    "blob:",
    "https://g.alicdn.com",
    "'sha256-YWDKpAXTqwkBgKv52boPcHHeIFM0KgmGRB7P5BAYG1g='",
    "'sha256-rukASNY1jEwwaAb4qYHy6q+Vz2CBb8DRFWqOn3yc534='",
    "'sha256-QrA3rhcCnVi1raBBazigw1S+co1eZTAaQED3N3leMaw='",
  ],
  "style-src": ["'unsafe-inline'", "https://g.alicdn.com"],
  "img-src": ["data:", "blob:", "https://img.alicdn.com", "https://gw.alicdn.com"],
  "font-src": ["data:", "https://g.alicdn.com"],
  "media-src": ["blob:"],
  "connect-src": [
    "https://*.aliyuncs.com",
    "wss://*.aliyuncs.com",
    "https://eds.aliyun.com",
    "https://eds-intl.aliyun.com",
    "https://g.alicdn.com",
  ],
  "worker-src": ["blob:"],
  "frame-src": ["'self'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
};
const screen = serialize({
  ...WUYING_DIRECTIVES,
  "frame-ancestors": ["'self'"],
});
// Only the pinned nested runtime loads MQTT and fetches the decoder's embedded Wasm data URL.
const runtime = serialize({
  ...WUYING_DIRECTIVES,
  "script-src": [
    ...WUYING_DIRECTIVES["script-src"]!,
    "https://o.alicdn.com/aliyun-ecs/eds-cdn/paho-mqtt/mqttws31.min.js",
  ],
  "connect-src": [
    ...WUYING_DIRECTIVES["connect-src"]!,
    // The desktop ticket can pick a gateway port other than 443.
    "wss://*.wuying.aliyuncs.com:*",
    "data:",
  ],
});

export const wuyingScreenPolicy: EmbeddedComputerScreenPolicy = { screen, runtime };
