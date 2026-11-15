import type { Actor } from "@rakazo/contracts";
import { buildSkillMd, parseSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createAgentSkillsService, resolveSkillContent } from "./agent-skills.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

function savedSkill(name: string, source = "user") {
  return {
    id: "saved-1",
    spaceId: actor.spaceId,
    userId: actor.userId,
    name,
    description: "Saved review recipe",
    content: buildSkillMd({ name, description: "Saved review recipe", body: "Saved steps" }),
    source,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function setup(rows: ReturnType<typeof savedSkill>[] = []) {
  type Where = { id?: string; spaceId?: string; userId: string; source?: string; OR?: object[] };
  const matches = (row: ReturnType<typeof savedSkill>, where: object): boolean =>
    Object.entries(where).every(([key, value]) =>
      key === "OR"
        ? (value as object[]).some((branch) => matches(row, branch))
        : row[key as keyof typeof row] === value,
    );
  const agentSkill = {
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      rows.filter((row) => matches(row, where)),
    ),
    findFirst: vi.fn(async ({ where }: { where: Where }) =>
      rows.find((row) => matches(row, where)),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: object }) => {
      const row = rows.find((row) => matches(row, where));
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const index = rows.findIndex((row) => matches(row, where));
      if (index < 0) return { count: 0 };
      rows.splice(index, 1);
      return { count: 1 };
    }),
  };
  const tx = { agentSkill, $executeRaw: vi.fn(async () => 0), $queryRaw: vi.fn(async () => []) };
  const $transaction = vi.fn(async (run: (client: typeof tx) => unknown) => run(tx));
  return {
    agentSkill,
    service: createAgentSkillsService({ agentSkill, $transaction } as unknown as PrismaClient),
  };
}

const interrogates = <T extends { name: string }>(skills: T[]) =>
  skills.filter((skill) => skill.name.trim().toLowerCase() === "interrogate");

describe("built-in skill precedence in the API", () => {
  it.each(["interrogate", " Interrogate "])(
    "keeps %j listed, readable and mutable",
    async (name) => {
      const { service } = setup([savedSkill(name)]);
      expect(interrogates(await service.list(actor))).toEqual([
        expect.objectContaining({ id: "saved-1", name, readOnly: false }),
      ]);
      expect(interrogates(await service.listWithContent(actor))).toEqual([
        expect.objectContaining({ id: "saved-1", content: expect.stringContaining("Saved steps") }),
      ]);
      await expect(service.get(actor, { name: " INTERROGATE " })).resolves.toMatchObject({
        id: "saved-1",
        source: "user",
      });
      await expect(service.get(actor, { skillId: "saved-1" })).resolves.toMatchObject({ name });
      await expect(
        service.update(actor, { skillId: "saved-1", description: "Updated recipe" }),
      ).resolves.toMatchObject({ name: name.trim(), description: "Updated recipe" });
      await expect(service.remove(actor, "saved-1")).resolves.toEqual({ ok: true });
      await expect(service.get(actor, { name: "Interrogate" })).resolves.toMatchObject({
        id: "builtin:Interrogate",
        readOnly: true,
      });
    },
  );

  it("preserves plugin precedence and read-only enforcement", async () => {
    const { service, agentSkill } = setup([savedSkill(" Interrogate ", "plugin")]);
    await expect(service.get(actor, { name: "interrogate" })).resolves.toMatchObject({
      id: "saved-1",
      source: "plugin",
      readOnly: true,
    });
    await expect(service.update(actor, { skillId: "saved-1", body: "Changed" })).rejects.toThrow(
      "read-only",
    );
    await expect(service.remove(actor, "saved-1")).rejects.toThrow("read-only");
    expect(agentSkill.updateMany).not.toHaveBeenCalled();
    expect(agentSkill.deleteMany).not.toHaveBeenCalled();
  });

  it.each([{ spaceId: "other-space" }, { userId: "other-user" }])(
    "does not let foreign skills shadow the builtin: %j",
    async (foreignOwner) => {
      const { service } = setup([{ ...savedSkill(" Interrogate "), ...foreignOwner }]);
      await expect(service.get(actor, { name: "interrogate" })).resolves.toMatchObject({
        id: "builtin:Interrogate",
        readOnly: true,
      });
      expect(interrogates(await service.list(actor))).toEqual([
        expect.objectContaining({ id: "builtin:Interrogate" }),
      ]);
      await expect(service.get(actor, { skillId: "saved-1" })).rejects.toThrow();
    },
  );
});

describe("imported skill content in the API", () => {
  it("keeps multiline keep-chomp metadata editable after normalization", async () => {
    const imported = resolveSkillContent({
      content: `---
name: Release notes
description: Prepare release notes
notes: |+
  First step
  Second step

---

Write the notes.
`,
    });
    const { service } = setup([{ ...savedSkill(imported.name), ...imported }]);

    const updated = await service.update(actor, {
      skillId: "saved-1",
      description: "Prepare weekly release notes",
      body: "Write the weekly notes.",
    });

    const parsed = parseSkillMd(updated.content);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.name).toBe("Release notes");
    expect(parsed.description).toBe("Prepare weekly release notes");
    expect(parsed.body).toBe("Write the weekly notes.");
    expect(parsed.frontmatter.notes).toBe("First step\nSecond step\n\n");
  });
});
