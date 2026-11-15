import path from "node:path";
import { lingui } from "@lingui/vite-plugin";
import { buildIdAt } from "@rakazo/contracts/client-build";
import {
  COMPUTER_SCREEN_PREFIX,
  COMPUTER_SCREEN_RUNTIME_PATH,
  contentSecurityPolicyFor,
} from "@rakazo/contracts/content-security-policy";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { wuyingScreenAssets } from "../../packages/adapters/src/wuying-screen-assets.ts";
import { wuyingScreenPolicy } from "../../packages/adapters/src/wuying-screen-policy.ts";
import { createServiceLogger } from "../../packages/logging/src/env.ts";
import { apiProxy } from "./src/api-proxy.js";
import { withInstanceThemeLink } from "./src/instance-theme.js";
import {
  attachDesktopStackProbe,
  attachNovncProxy,
  attachPreviewMiddleware,
  sharedPageHeaders,
  webServerSettings,
} from "./src/preview-middleware.js";
import { rakazoPwa } from "./src/pwa/plugin.js";

export default defineConfig(({ command, mode }) => {
  // Names this build in every API request; the dev server has none, so the handshake stays off.
  const buildId = command === "build" ? buildIdAt(new Date()) : "";
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  const webPort = Number(process.env.WEB_PORT ?? rootEnv.WEB_PORT ?? 5173);
  const settings = webServerSettings(
    (name) => process.env[name] ?? rootEnv[name],
    createServiceLogger({ service: "rakazo-web" }),
  );
  const { api, allowedHosts, appPolicy, instanceTheme } = settings;
  // Set by the server built from this config; reusing one config object for two servers would
  // leave the last one's list.
  let proxyHosts: readonly string[] | true = [];
  const proxy = apiProxy(api, () => proxyHosts);
  return {
    build: {
      sourcemap: true,
      rolldownOptions: {
        output: {
          codeSplitting: {
            // Shared chunks that build schemas run before the entry chunk's body, so the Zod
            // config only lands in time when it ships inside Zod's own chunk.
            groups: [
              { name: "zod", test: /[\\/]node_modules[\\/]zod[\\/]|[\\/]src[\\/]zod-config\.ts$/ },
            ],
          },
        },
      },
    },
    define: { "import.meta.env.RAKAZO_BUILD": JSON.stringify(buildId) },
    plugins: [
      {
        // The API reads this to name the deployed build, and a tab fetches it to confirm the
        // server already serves a newer build before it reloads.
        name: "rakazo-build-id",
        apply: "build",
        generateBundle() {
          this.emitFile({ type: "asset", fileName: "build-id", source: `${buildId}\n` });
        },
      },
      react(),
      babel({ plugins: ["@lingui/babel-plugin-lingui-macro"] }),
      lingui(),
      tailwindcss(),
      rakazoPwa(buildId),
      {
        // Dev keeps React Refresh unrestricted in app pages; screen documents always use CSP.
        name: "rakazo-content-security-policy",
        generateBundle() {
          for (const [pathname, asset] of Object.entries(wuyingScreenAssets)) {
            this.emitFile({ type: "asset", fileName: pathname.slice(1), source: asset.source });
          }
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const pathname = req.url?.split("?", 1)[0] ?? "/";
            if (pathname.startsWith(COMPUTER_SCREEN_PREFIX)) {
              res.setHeader(
                "content-security-policy",
                contentSecurityPolicyFor(pathname, appPolicy, wuyingScreenPolicy)!,
              );
              if (pathname !== COMPUTER_SCREEN_RUNTIME_PATH)
                res.setHeader("x-frame-options", "SAMEORIGIN");
            }
            const asset = Object.hasOwn(wuyingScreenAssets, pathname)
              ? wuyingScreenAssets[pathname]
              : undefined;
            if (asset) {
              res.setHeader("content-type", asset.type);
              res.end(asset.source);
              return;
            }
            next();
          });
          server.middlewares.use(sharedPageHeaders);
          if (instanceTheme) server.middlewares.use(instanceTheme);
          attachDesktopStackProbe(server, settings);
          // The hosts the running server allows, as Vite resolved them, for proxied upgrades.
          proxyHosts = server.config.server.allowedHosts;
          attachNovncProxy(server, settings);
        },
        configurePreviewServer(server) {
          proxyHosts = server.config.preview.allowedHosts;
          const { config } = server;
          const outDir = path.resolve(config.root, config.build.outDir);
          // Returned as a post hook, so it runs after Vite's SPA fallback has resolved the page.
          return attachPreviewMiddleware(server, settings, {
            root: config.root,
            outDir,
            assetsDir: path.join(outDir, config.build.assetsDir),
            assetsUrl: `${config.base}${config.build.assetsDir}/`,
          });
        },
      },
      {
        // Without RAKAZO_THEME the page never links the theme, so the default deploy is unchanged.
        name: "rakazo-instance-theme",
        transformIndexHtml: (html) =>
          command === "serve" && instanceTheme ? withInstanceThemeLink(html) : html,
      },
    ],
    server: {
      host: process.env.RAKAZO_DEV_HOST ?? rootEnv.RAKAZO_DEV_HOST ?? "127.0.0.1",
      port: webPort,
      strictPort: true,
      allowedHosts,
      proxy,
    },
    preview: {
      host: "0.0.0.0",
      port: webPort,
      allowedHosts,
      proxy,
    },
  };
});
