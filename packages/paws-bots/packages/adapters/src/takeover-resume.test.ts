import { describe, expect, it } from "vitest";
import {
  continueRunClaimFence,
  refreshTakeoverContinuePlan,
  takeoverContinuePlan,
  takeoverResumeFromRelease,
} from "./takeover-resume.js";

const HANDED_BACK_NOTE =
  "The user finished on the computer. Take a fresh screenshot before acting on the screen. Do not request takeover again for this same step.";
const UNFINISHED_NOTE =
  "The user skipped this step. Continue without assuming that step was done. Take a fresh screenshot before acting on the screen. Do not request takeover again for this same step unless you still cannot proceed.";

describe("takeoverResumeFromRelease", () => {
  it("only rules out asking for the same step again, so a later code can still be asked for", () => {
    for (const reason of ["done", "skipped"]) {
      expect(takeoverResumeFromRelease(reason).promptNote).toContain("for this same step");
    }
  });

  it("tells the bot the person finished and to look at the screen again after I'm done", () => {
    for (const reason of ["done", undefined]) {
      const resume = takeoverResumeFromRelease(reason);
      expect(resume.checkpoint).toBe("takeover");
      expect(resume.promptNote).toBe(HANDED_BACK_NOTE);
      expect(resume.promptNote).not.toMatch(/login/i);
    }
  });

  it("tells the bot a skipped takeover was not completed", () => {
    const resume = takeoverResumeFromRelease("skipped");
    expect(resume.checkpoint).toBe("takeover-skipped");
    expect(resume.promptNote).toBe(UNFINISHED_NOTE);
    expect(resume.promptNote).not.toMatch(/login/i);
  });
});

describe("takeoverContinuePlan", () => {
  it("keeps a waiting takeover held without treating login as finished", () => {
    const plan = takeoverContinuePlan({ status: "waiting_takeover", checkpoint: null });
    expect(plan.heldForTakeover).toBe(true);
    expect(plan.resumeCheckpoint).toBeNull();
    expect(plan.takeoverResume).toBeNull();
  });

  it("resumes after a finished or skipped takeover from the release checkpoint", () => {
    const done = takeoverContinuePlan({ status: "queued", checkpoint: "takeover" });
    expect(done.heldForTakeover).toBe(false);
    expect(done.takeoverResume?.checkpoint).toBe("takeover");
    expect(done.takeoverResume?.promptNote).toBe(HANDED_BACK_NOTE);
    expect(done.takeoverResume?.promptNote).not.toMatch(/login/i);

    const skipped = takeoverContinuePlan({
      status: "queued",
      checkpoint: "takeover-skipped",
    });
    expect(skipped.heldForTakeover).toBe(false);
    expect(skipped.takeoverResume?.checkpoint).toBe("takeover-skipped");
    expect(skipped.takeoverResume?.promptNote).toBe(UNFINISHED_NOTE);
    expect(skipped.takeoverResume?.promptNote).not.toMatch(/login/i);
  });

  it("does not treat a normal continue as a takeover resume", () => {
    expect(takeoverContinuePlan({ status: "queued", checkpoint: null })).toEqual({
      resumeCheckpoint: null,
      heldForTakeover: false,
      takeoverResume: null,
    });
  });
});

describe("continueRunClaimFence", () => {
  it("pins the claim to the observed status and checkpoint", () => {
    expect(continueRunClaimFence({ status: "waiting_takeover", checkpoint: null })).toEqual({
      status: "waiting_takeover",
      checkpoint: null,
    });
    expect(continueRunClaimFence({ status: "queued", checkpoint: "takeover" })).toEqual({
      status: "queued",
      checkpoint: "takeover",
    });
  });
});

describe("refreshTakeoverContinuePlan", () => {
  it("ends the held gate when release stamps a checkpoint on the running run", () => {
    const held = takeoverContinuePlan({ status: "waiting_takeover", checkpoint: null });
    const released = refreshTakeoverContinuePlan(held, {
      status: "running",
      checkpoint: "takeover",
    });
    expect(released.heldForTakeover).toBe(false);
    expect(released.resumeCheckpoint).toBe("takeover");
    expect(released.takeoverResume?.checkpoint).toBe("takeover");
  });

  it("keeps the hold when no release checkpoint is present", () => {
    const held = takeoverContinuePlan({ status: "waiting_takeover", checkpoint: null });
    expect(refreshTakeoverContinuePlan(held, { status: "running", checkpoint: null })).toBe(held);
  });
});
