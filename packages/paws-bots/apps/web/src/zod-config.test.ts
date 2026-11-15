import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import "./zod-config";

afterEach(() => {
  vi.restoreAllMocks();
});

it("parses objects without probing for eval, which the CSP reports", () => {
  const probe = vi.spyOn(globalThis, "Function");
  expect(z.object({ name: z.string() }).parse({ name: "Ada" })).toEqual({ name: "Ada" });
  expect(probe).not.toHaveBeenCalled();
});
