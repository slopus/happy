import { createDb } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { captureIosProviderLimitError } from "./cli/ios-screenshot-error.js";

vi.mock("@rakazo/db", () => ({ createDb: vi.fn() }));

describe("provider limit screenshot section", () => {
  it.each([false, true])("restores the healthy run when capture fails: %s", async (fails) => {
    const original = {
      id: "fixture-run",
      status: "completed",
      error: null as string | null,
      updatedAt: new Date("2026-10-01"),
    };
    const stored = { ...original };
    const disconnect = vi.fn();
    const end = vi.fn();
    vi.mocked(createDb).mockReturnValue({
      prisma: {
        run: {
          findFirstOrThrow: vi.fn(async () => ({ ...stored })),
          update: vi.fn(async ({ data }: { data: Partial<typeof stored> }) =>
            Object.assign(stored, { updatedAt: new Date() }, data),
          ),
        },
        $disconnect: disconnect,
      },
      pool: { end },
    } as unknown as ReturnType<typeof createDb>);
    const capture = vi.fn(async () => {
      expect(stored.status).toBe("failed");
      expect(stored.error).toContain("weekly limit");
      const diagnostic = JSON.parse(stored.error?.slice(5) ?? "");
      expect(Date.parse(diagnostic.metadata.reset_at)).toBeGreaterThan(Date.now());
      if (fails) throw new Error("capture failed");
    });
    const operation = captureIosProviderLimitError("postgres://fixture", "fixture-bot", capture);
    if (fails) await expect(operation).rejects.toThrow("capture failed");
    else await operation;
    expect(capture).toHaveBeenCalledOnce();
    expect(stored).toEqual(original);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});
