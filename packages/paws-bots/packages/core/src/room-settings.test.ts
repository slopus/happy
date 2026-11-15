import { describe, expect, it } from "vitest";
import {
  ambientValue,
  listenMode,
  roomAutomatedSenders,
  senderPolicy,
  withRollupHours,
  withSenderMode,
} from "./room-settings.js";

const github = { id: "B_GITHUB", name: "GitHub" };

describe("room settings", () => {
  it("round-trips listening between the stored value and the mode", () => {
    for (const ambient of [null, true, false])
      expect(ambientValue(listenMode(ambient))).toBe(ambient);
  });

  it("lists seen and saved senders once, by name", () => {
    const senders = roomAutomatedSenders(
      { B_OLD: { name: "Alerts", mode: "action" }, B_GITHUB: { name: "GitHub", mode: "ignore" } },
      [github, { id: "B_ZAP", name: "Zapier" }],
    );
    expect(senders.map((sender) => sender.name)).toEqual(["Alerts", "GitHub", "Zapier"]);
  });

  it("ignores senders without a policy", () => {
    expect(senderPolicy({}, github)).toEqual({ name: "GitHub", mode: "ignore" });
  });

  it("gives grouped senders a default frequency and keeps a saved one", () => {
    expect(withSenderMode({}, github, "rollup").B_GITHUB).toEqual({
      name: "GitHub",
      mode: "rollup",
      rollupHours: 6,
    });
    const saved = withRollupHours({}, github, 12);
    expect(
      withSenderMode(withSenderMode(saved, github, "rollup"), github, "rollup").B_GITHUB
        ?.rollupHours,
    ).toBe(12);
    expect(withSenderMode(saved, github, "action").B_GITHUB).toEqual({
      name: "GitHub",
      mode: "action",
    });
  });

  it("clamps the grouping frequency", () => {
    expect(withRollupHours({}, github, 0).B_GITHUB?.rollupHours).toBe(1);
    expect(withRollupHours({}, github, 10_000).B_GITHUB?.rollupHours).toBe(720);
    expect(withRollupHours({}, github, Number.NaN).B_GITHUB?.rollupHours).toBe(6);
  });
});
