import path from "node:path";
import { lingui } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Every selector, including Tailwind's reset and theme roots, belongs to Bots.
// Keyframe selectors are animation steps, not document selectors.
const scopeStyles = {
  postcssPlugin: "paws-bots-scope",
  Rule(rule: { selector: string; parent?: { type: string; name?: string } }) {
    if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name ?? "")) return;
    if (!rule.selector || rule.selector.includes("[data-paws-bots]")) return;
    rule.selector = rule.selector.split(/,(?![^()]*\))/).map(selector => {
      let scoped = selector.trim().replace(/:root|:host(?![\w-])|(?<![\w-])html(?![\w-])|(?<![\w-])body(?![\w-])|#root\b/g, "[data-paws-bots]");
      if (scoped.startsWith("[data-theme=")) scoped = "[data-paws-bots]" + scoped;
      return scoped.includes("[data-paws-bots]") ? scoped : `[data-paws-bots] ${scoped}`;
    }).join(",");
  },
};
export default defineConfig({
  base: "/bots-assets/",
  resolve: { dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react"] },
  define: { "import.meta.env.RAKAZO_BUILD": '""', "import.meta.env.PAWS_EMBEDDED": "true", "process.env.NODE_ENV": '"production"' },
  plugins: [react(), babel({ plugins: ["@lingui/babel-plugin-lingui-macro"] }), lingui(), tailwindcss()],
  css: { postcss: { plugins: [scopeStyles] } },
  build: {
    outDir: "dist-embedded", sourcemap: true,
    lib: { entry: path.resolve(import.meta.dirname, "src/paws/entry.ts"), name: "PawsBots", formats: ["iife"], fileName: () => "bots.js", cssFileName: "bots" },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
