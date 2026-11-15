import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const read = (file: string) => JSON.parse(readFileSync(path.join(repoRoot, file), "utf8"));

// EAS installs its own pnpm instead of the packageManager pin, so every profile must name it.
it("pins the workspace pnpm version in every EAS build profile", () => {
  const pnpm = read("package.json").packageManager.replace(/^pnpm@/, "");
  const profiles: Record<string, { extends?: string; pnpm?: string }> =
    read("apps/mobile/eas.json").build;
  const resolve = (name: string): string | undefined => {
    const profile = profiles[name];
    return profile?.pnpm ?? (profile?.extends ? resolve(profile.extends) : undefined);
  };
  for (const name of Object.keys(profiles)) expect([name, resolve(name)]).toEqual([name, pnpm]);
});
