import { readFileSync } from "node:fs";
import { COMPUTER_SCREEN_PREFIX } from "@rakazo/contracts/content-security-policy";

/** Browser-side adapter files served alongside the separately downloaded SDK. */
export const wuyingScreenAssets = Object.fromEntries(
  ["screen.html", "screen.js", "storage.js"].map((name) => [
    `${COMPUTER_SCREEN_PREFIX}${name}`,
    {
      type: name.endsWith(".html") ? "text/html" : "text/javascript",
      source: readFileSync(new URL(`./wuying-screen/${name}`, import.meta.url), "utf8"),
    },
  ]),
);
