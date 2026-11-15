import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { lingui } from "@lingui/vite-plugin";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const linguiCli = path.join(path.dirname(require.resolve("@lingui/cli")), "lingui.js");
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

let project: string | undefined;
afterEach(() => {
  if (project) rmSync(project, { recursive: true, force: true });
  project = undefined;
});

/** A web app with one string that no committed catalog lists yet. */
function newStringProject() {
  project = mkdtempSync(path.join(tmpdir(), "rakazo-lingui-"));
  mkdirSync(path.join(project, "src"));
  writeFileSync(
    path.join(project, "src/app.ts"),
    'import { t } from "@lingui/core/macro";\nexport const label = () => t`Brand new string`;\n',
  );
  for (const locale of ["en", "de"]) {
    mkdirSync(path.join(project, "locales", locale), { recursive: true });
    writeFileSync(path.join(project, "locales", locale, "messages.po"), "");
  }
  const configPath = path.join(project, "lingui.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      sourceLocale: "en",
      locales: ["en", "de"],
      catalogs: [{ path: "<rootDir>/locales/{locale}/messages", include: ["<rootDir>/src"] }],
    }),
  );
  return { configPath, german: path.join(project, "locales/de/messages.po") };
}

/** Compiles a catalog the way a production build imports it. */
async function compiledCatalog(configPath: string, file: string) {
  const [config, loader] = lingui({ configPath });
  (config!.configResolved as () => void)();
  const transform = loader!.transform as {
    handler: (this: unknown, src: string, id: string) => Promise<{ code: string }>;
  };
  const context = { addWatchFile: () => undefined, warn: () => undefined };
  const { code } = await transform.handler.call(context, "", file);
  const compiled = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as {
    messages: Record<string, unknown>;
  };
  return Object.values(compiled.messages);
}

// A production build strips each string's English text and keeps only its id, so a string
// missing from the catalog a page loads would show that id.
describe("strings the committed catalogs do not list yet", () => {
  it("are missing from a catalog compiled without the extracted template", async () => {
    const { configPath, german } = newStringProject();
    expect(await compiledCatalog(configPath, german)).toEqual([]);
  });

  it("compile to their English text once the build extracts the template", async () => {
    const { configPath, german } = newStringProject();
    execFileSync(
      process.execPath,
      [linguiCli, "extract-template", "--config", configPath, "--workers", "1"],
      { stdio: "pipe" },
    );
    expect(await compiledCatalog(configPath, german)).toEqual([["Brand new string"]]);
  });

  it("are extracted by every production build", () => {
    expect(packageJson.scripts.build).toMatch(/^lingui extract-template && .*vite build$/);
  });
});
