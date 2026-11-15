import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const composeDir = path.resolve(import.meta.dirname, "../../compose");

describe.each(["docker-compose.images.yml", "docker-compose.prod.yml"])("%s web", (file) => {
  const compose = parse(readFileSync(path.join(composeDir, file), "utf8")) as {
    services: Record<string, { pids_limit?: number; environment?: Record<string, unknown> }>;
  };
  const web = compose.services.web;

  it("caps Rolldown's per-CPU thread pool well below its pids_limit (#2430)", () => {
    const threads = Number(web?.environment?.RAYON_NUM_THREADS);
    expect(threads).toBeGreaterThan(0);
    expect(threads).toBeLessThan((web?.pids_limit ?? 0) / 4);
  });
});
