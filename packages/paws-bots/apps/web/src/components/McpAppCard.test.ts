import { readFileSync } from "node:fs";
import path from "node:path";
import { MCP_APP_VIEWER_PATH } from "@rakazo/contracts/content-security-policy";
import { MCP_APP_SHELL_HTML } from "@rakazo/core";
import { expect, it } from "vitest";

it("serves the app shell exactly as core defines it", () => {
  // Regenerate with MCP_APP_SHELL_HTML when this fails; the native apps embed the same shell.
  const served = readFileSync(
    path.join(import.meta.dirname, "../../public", MCP_APP_VIEWER_PATH),
    "utf8",
  );
  expect(served).toBe(MCP_APP_SHELL_HTML);
});
