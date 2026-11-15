import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./generated/prisma/client.js";
import { sanitizeWriteArgs, withTextSanitization } from "./text-sanitization.js";

describe("sanitizeWriteArgs", () => {
  it("replaces NUL and unpaired surrogates in written text and json", () => {
    const at = new Date(0);
    const bytes = new Uint8Array([0]);
    const args = {
      where: { id: "a\0b" },
      data: {
        prompt: "hi\0there 😀",
        createdAt: at,
        ciphertext: bytes,
        payload: { blocks: [{ text: "x\uD800y" }, { text: "fine" }] },
        runs: { create: [{ status: "queued", note: "\uDC00" }] },
      },
    };

    const out = sanitizeWriteArgs("create", args) as typeof args;

    expect(out.data.prompt).toBe("hi�there 😀");
    expect(out.data.payload.blocks[0]?.text).toBe("x�y");
    expect(out.data.payload.blocks[1]).toBe(args.data.payload.blocks[1]);
    expect(out.data.runs.create[0]?.note).toBe("�");
    expect(out.data.createdAt).toBe(at);
    expect(out.data.ciphertext).toBe(bytes);
    // Filters are not rewritten, and the caller's object is not mutated.
    expect(out.where).toBe(args.where);
    expect(args.data.prompt).toBe("hi\0there 😀");
  });

  it("covers both sides of an upsert and returns clean args unchanged", () => {
    const upsert = sanitizeWriteArgs("upsert", {
      where: { id: "1" },
      create: { name: "a\0" },
      update: { name: "b\0" },
    });
    expect(upsert).toEqual({
      where: { id: "1" },
      create: { name: "a�" },
      update: { name: "b�" },
    });

    const clean = { data: [{ name: "ok" }] };
    expect(sanitizeWriteArgs("createMany", clean)).toBe(clean);
  });

  it("cleans JSON keys and keeps keys that collide once cleaned", () => {
    const out = sanitizeWriteArgs("create", {
      data: { payload: { "a\0b": 1, "a�b": 2, nested: { "\uD800": "x" } } },
    });
    expect(out).toEqual({
      data: { payload: { "a�b": 1, "a�b#2": 2, nested: { "�": "x" } } },
    });
  });

  it("keeps a parsed __proto__ key as data when cleaning keys", () => {
    const payload = JSON.parse('{"bad\\u0000":1,"__proto__":{"keep":2}}');
    const out = sanitizeWriteArgs("create", { data: { payload } }) as {
      data: { payload: Record<string, unknown> };
    };

    expect(Object.getPrototypeOf(out.data.payload)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(out.data.payload))).toEqual(
      JSON.parse('{"bad\\ufffd":1,"__proto__":{"keep":2}}'),
    );
    expect(Object.hasOwn(out.data.payload, "__proto__")).toBe(true);
  });

  it("leaves reads alone", () => {
    const args = { where: { name: "a\0" } };
    expect(sanitizeWriteArgs("findFirst", args)).toBe(args);
  });
});

describe("withTextSanitization", () => {
  it("cleans arguments before the query runs", async () => {
    type Hook = (input: {
      operation: string;
      args: unknown;
      query: (args: unknown) => Promise<unknown>;
    }) => Promise<unknown>;
    let hook: Hook | undefined;
    const prisma = {
      $extends: vi.fn((extension: { query: { $allModels: { $allOperations: Hook } } }) => {
        hook = extension.query.$allModels.$allOperations;
        return prisma;
      }),
    } as unknown as PrismaClient;
    withTextSanitization(prisma);
    const query = vi.fn(async (args: unknown) => args);

    await hook?.({ operation: "create", args: { data: { prompt: "\0" } }, query });

    expect(query).toHaveBeenCalledWith({ data: { prompt: "�" } });
  });
});
