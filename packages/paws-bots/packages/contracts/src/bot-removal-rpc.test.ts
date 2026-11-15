import { expect, it } from "vitest";
import { appContract } from "./rpc.js";

it("accepts old deletion responses and preserves committed group IDs from new servers", () => {
  const output = appContract.bots.remove["~orpc"].outputSchema!;
  expect(output.parse({ ok: true })).toEqual({ ok: true });
  expect(output.parse({ ok: true, removedGroupIds: ["group-1"] })).toEqual({
    ok: true,
    removedGroupIds: ["group-1"],
  });
  expect(output.parse({ ok: true, removedGroupIds: [] })).toEqual({
    ok: true,
    removedGroupIds: [],
  });
  expect(output.safeParse({ ok: true, removedGroupIds: [12] }).success).toBe(false);
});
