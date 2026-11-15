import { describe, expect, it } from "vitest";
import {
  AGENT_IMPORT_MAX_FILE_LENGTH,
  AGENT_IMPORT_MAX_TOTAL_LENGTH,
  AgentImportPreviewInput,
} from "./agent-import.js";

const accepts = (files: { path: string; content: string }[]) =>
  AgentImportPreviewInput.safeParse({ files }).success;

describe("agent import files", () => {
  it("accepts relative Markdown paths and the settings files at a home's root", () => {
    for (const path of [
      "workspace/skills/a/SKILL.md",
      ".openclaw/openclaw.json",
      ".openclaw/.env",
      ".openclaw/cron/jobs.json",
      ".hermes/config.yaml",
      ".hermes/auth.json",
      ".hermes/skills/.bundled_manifest",
      "config.yaml",
    ]) {
      expect(accepts([{ path, content: "x" }]), path).toBe(true);
    }
  });

  it("rejects paths outside the chosen folder and non-Markdown files", () => {
    for (const path of [
      "../SOUL.md",
      "workspace/../SOUL.md",
      "/etc/SOUL.md",
      "C:/SOUL.md",
      "workspace\\SOUL.md",
      "workspace//SOUL.md",
      ".openclaw/workspace/.env",
      ".openclaw/openclaw.json.bak",
      ".openclaw/state/openclaw.sqlite",
      ".openclaw/config-journal-fingerprint.key",
      ".openclaw/agents/main/agent/auth-profiles.json",
      ".hermes/cron/output/run.json",
    ]) {
      expect(accepts([{ path, content: "x" }]), path).toBe(false);
    }
  });

  it("bounds file size, total size and duplicates", () => {
    expect(accepts([{ path: "a.md", content: "x".repeat(AGENT_IMPORT_MAX_FILE_LENGTH + 1) }])).toBe(
      false,
    );
    const count = Math.ceil(AGENT_IMPORT_MAX_TOTAL_LENGTH / AGENT_IMPORT_MAX_FILE_LENGTH) + 1;
    const files = Array.from({ length: count }, (_, index) => ({
      path: `memory/${index}.md`,
      content: "x".repeat(AGENT_IMPORT_MAX_FILE_LENGTH),
    }));
    expect(accepts(files)).toBe(false);
    expect(
      accepts([
        { path: "a.md", content: "" },
        { path: "a.md", content: "" },
      ]),
    ).toBe(false);
  });
});
