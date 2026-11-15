import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

// One catalog for web and mobile, so a string both apps show is translated once. Lingui finds this
// file from either app's folder.
export default defineConfig({
  sourceLocale: "en",
  locales: [
    "en",
    "de",
    "ko",
    "tr",
    "hi",
    "pt-BR",
    "zh-CN",
    "zh-TW",
    "es",
    "ru",
    "fr",
    "he",
    "nl",
    "ja",
    "pl",
  ],
  catalogs: [
    {
      path: "<rootDir>/packages/i18n/locales/{locale}/messages",
      include: [
        "<rootDir>/apps/web/src",
        "<rootDir>/packages/i18n/src",
        "<rootDir>/apps/mobile/app",
        "<rootDir>/apps/mobile/components",
        "<rootDir>/apps/mobile/lib",
      ],
      exclude: ["**/locales/**", "**/*.test.*", "**/node_modules/**"],
    },
  ],
  compileNamespace: "es",
  // Keep file paths in `#:` origins, but drop line numbers. A shift in a large
  // source file otherwise rewrites the same reference in every locale catalog.
  format: formatter({ lineNumbers: false }),
});
