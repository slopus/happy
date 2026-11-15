import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("checks live page browser protocol failure handling offline", { timeout: 70_000 }, () => {
  const tests = fileURLToPath(new URL("../../computer/test_page_browser.py", import.meta.url));
  // A loaded CI runner can take well over ten seconds to start Python and run these checks.
  expect(() => execFileSync("python3", [tests], { timeout: 60_000, stdio: "pipe" })).not.toThrow();
});
