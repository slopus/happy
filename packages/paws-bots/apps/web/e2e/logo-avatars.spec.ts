import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { BOT_COLORS } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

test.use({ viewport: { width: 1260, height: 1000 } });

test("renders the real logo in every requested pose in both themes", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["dark", "light"]) {
    await page.goto(`/e2e/fixtures/logo-avatars.html?theme=${theme}`);
    await expect(page.getByRole("img", { name: "Official Rakazo logo" })).toBeVisible();
    const cards = page.getByRole("region", { name: "Requested expressions" });
    for (const label of ["Idle", "Reading", "Writing", "Thinking", "Computer use"]) {
      await expect(cards.getByRole("img", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.locator('.rakazo-logo-avatar[data-artwork-fallback="true"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    const smallAnimations = await page
      .locator('.rakazo-logo-avatar[data-motion="false"]')
      .evaluateAll((elements) =>
        elements.flatMap((element) =>
          element.getAnimations({ subtree: true }).map((animation) => animation.playState),
        ),
      );
    expect(smallAnimations).toEqual([]);
    await expect(page.locator(".rakazo-bot-avatar-picture img")).toBeVisible();
    await expect(page.locator(".bot-character-eyes")).toBeVisible();
    await captureScreenshot(page, testInfo, `logo-avatar-study-${theme}`);
  }
  expect(errors).toEqual([]);
});

test("resolves real public event shapes without pretending unknown work is thinking", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/logo-avatars.html");
  const replay = page
    .getByRole("region", { name: "Transitions and runtime events" })
    .locator("article")
    .last();
  const state = page.getByTestId("resolved-activity");
  for (const [label, expected] of [
    ["Start run", "working"],
    ["Thinking starts", "thinking"],
    ["Thinking ends", "working"],
    ["Read file", "reading"],
    ["Finish reading", "working"],
    ["Stream reply", "writing"],
    ["Use computer", "computer"],
    ["Ask for input", "waiting"],
    ["Resume run", "working"],
    ["Run fails", "error"],
    ["Restart", "working"],
    ["Interrupt", "idle"],
  ]) {
    await replay.getByRole("button", { name: label, exact: true }).click();
    await expect(state).toHaveText(expected!);
  }
});

test("motion changes the gaze, transitions smoothly and stops under reduced motion", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/logo-avatars.html");
  const reading = page.getByRole("img", { name: "Reading", exact: true });
  const scan = reading.locator(".logo-avatar-scan");
  const first = await scan.evaluate((node) => getComputedStyle(node).transform);
  await page.waitForTimeout(600);
  const second = await scan.evaluate((node) => getComputedStyle(node).transform);
  expect(second).not.toEqual(first);
  const durations = await Promise.all(
    [
      scan,
      page.getByRole("img", { name: "Writing", exact: true }).locator(".logo-avatar-scan"),
    ].map((element) =>
      element.evaluate((node) => Number.parseFloat(getComputedStyle(node).animationDuration)),
    ),
  );
  expect(durations[0]).toBeGreaterThan(2);
  expect(durations[1]).toBeLessThan(1.7);
  const switcher = page
    .getByRole("region", { name: "Transitions and runtime events" })
    .locator("article")
    .first();
  const selected = switcher.getByRole("img");
  const source = await selected.locator(".logo-avatar-art > path").first().getAttribute("d");
  await switcher.getByRole("button", { name: "Computer use", exact: true }).click();
  await expect(selected).toHaveAttribute("data-activity", "computer");
  await expect(
    selected.locator('[data-logo-layer][data-outgoing="false"] .logo-avatar-gaze'),
  ).toHaveCSS("transition-duration", "0.18s");
  expect(await selected.locator(".logo-avatar-art > path").first().getAttribute("d")).toBe(source);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const animated = await page
    .locator(".rakazo-logo-avatar")
    .evaluateAll((elements) =>
      elements.flatMap((element) =>
        element.getAnimations({ subtree: true }).map((animation) => animation.playState),
      ),
    );
  expect(animated).toEqual([]);
  await expect(scan).toHaveCSS("animation-name", "none");
  await expect(reading.locator(".logo-avatar-gaze")).toHaveCSS("transition-duration", "0s");
});

test("logo bodies are vector-only and do not request a body raster", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/bot-avatar-body.png*", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto("/e2e/fixtures/logo-avatars.html");
  const idle = page.getByRole("img", { name: "Idle", exact: true });
  await expect(idle).toHaveAttribute("data-vector-body", "true");
  await expect(idle.locator("image")).toHaveCount(0);
  await expect(idle.locator(".logo-avatar-art > path").first()).toBeVisible();
  expect(requests).toEqual([]);
});

test("same-state bots keep independent clocks and survive parent rerenders", async ({ page }) => {
  await page.goto("/e2e/fixtures/logo-avatars.html");
  const fleet = page.getByTestId("same-state-bots").getByRole("img");
  await expect(fleet).toHaveCount(6);
  const clocks = await fleet.evaluateAll((avatars) =>
    avatars.map((avatar) => {
      const style = getComputedStyle(avatar);
      const movement = getComputedStyle(avatar.querySelector(".logo-avatar-layer")!);
      return {
        blink: style.getPropertyValue("--logo-blink-duration"),
        blinkPhase: style.getPropertyValue("--logo-blink-delay"),
        move: movement.getPropertyValue("--logo-move-duration"),
        movePhase: movement.getPropertyValue("--logo-move-delay"),
        color: avatar.getAttribute("data-color"),
      };
    }),
  );
  expect(new Set(clocks.map((clock) => `${clock.blink}:${clock.blinkPhase}`)).size).toBe(6);
  expect(new Set(clocks.map((clock) => `${clock.move}:${clock.movePhase}`)).size).toBe(6);
  expect(new Set(clocks.map((clock) => clock.color)).size).toBe(6);
  const first = fleet.first();
  await first.evaluate((avatar) => {
    (window as any).avatarRerenderProof = {
      animations: avatar.getAnimations({ subtree: true }),
      style: avatar.getAttribute("style"),
      color: avatar.getAttribute("data-color"),
    };
  });
  await page
    .getByRole("button", { name: "Rerender preview" })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("main")).toHaveAttribute("data-rerenders", "1");
  expect(
    await first.evaluate((avatar) => {
      const before = (window as any).avatarRerenderProof;
      const after = avatar.getAnimations({ subtree: true });
      return (
        before.style === avatar.getAttribute("style") &&
        before.color === avatar.getAttribute("data-color") &&
        after.length === before.animations.length &&
        after.every((animation, index) => animation === before.animations[index])
      );
    }),
  ).toBe(true);
  await page.reload();
  await expect(fleet).toHaveCount(6);
  expect(
    await fleet.evaluateAll((avatars) =>
      avatars.map((avatar) => {
        const style = getComputedStyle(avatar);
        const movement = getComputedStyle(avatar.querySelector(".logo-avatar-layer")!);
        return {
          blink: style.getPropertyValue("--logo-blink-duration"),
          blinkPhase: style.getPropertyValue("--logo-blink-delay"),
          move: movement.getPropertyValue("--logo-move-duration"),
          movePhase: movement.getPropertyValue("--logo-move-delay"),
          color: avatar.getAttribute("data-color"),
        };
      }),
    ),
  ).toEqual(clocks);
});

test("one observer pauses offscreen avatars without a JavaScript animation clock", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const stats = { observers: 0, frames: 0, intervals: 0 };
    (window as any).avatarStats = stats;
    const NativeObserver = window.IntersectionObserver;
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        stats.observers++;
      }
    };
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      stats.frames++;
      return frame(callback);
    };
    const interval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, delay?: number, ...args: any[]) => {
      stats.intervals++;
      return interval(handler, delay, ...args);
    }) as typeof window.setInterval;
  });
  await page.goto("/e2e/fixtures/logo-avatars.html");
  const avatar = page.getByRole("img", { name: "Inbox reading", exact: true });
  await expect(avatar).toHaveAttribute("data-paused", "false");
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => ({ ...(window as any).avatarStats }));
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({ ...(window as any).avatarStats }));
  expect(before.observers).toBe(1);
  expect(after).toEqual(before);
  await avatar.evaluate((element) => {
    element.closest("section")!.style.marginTop = "2200px";
  });
  await expect(avatar).toHaveAttribute("data-paused", "true");
  await expect(avatar.locator(".logo-avatar-eye").first()).toHaveCSS(
    "animation-play-state",
    "paused",
  );
  expect(
    await avatar.evaluate((element) =>
      element.getAnimations({ subtree: true }).every((track) => track.playState === "paused"),
    ),
  ).toBe(true);
  const time = await avatar.evaluate((element) =>
    Number(element.getAnimations({ subtree: true })[0]!.currentTime),
  );
  await page.waitForTimeout(350);
  const pausedTime = await avatar.evaluate((element) =>
    Number(element.getAnimations({ subtree: true })[0]!.currentTime),
  );
  expect(Math.abs(pausedTime - time)).toBeLessThan(2);
  await avatar.evaluate((element) => {
    element.closest("section")!.style.marginTop = "0";
  });
  await expect(avatar).toHaveAttribute("data-paused", "false");
});

test("all native tracks close in pose and velocity at their own and common loop boundaries", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/logo-avatars.html");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.waitForTimeout(400);
  const proof = await page.evaluate(() => {
    const tracks = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY);
    tracks.forEach((animation) => {
      animation.pause();
    });
    const pose = (element: Element) => {
      const style = getComputedStyle(element);
      const matrix = new DOMMatrix(style.transform);
      const scaleX = Math.hypot(matrix.a, matrix.b);
      return [
        matrix.e,
        matrix.f,
        Math.atan2(matrix.b, matrix.a),
        scaleX,
        (matrix.a * matrix.d - matrix.b * matrix.c) / scaleX,
        Number(style.opacity),
      ];
    };
    const difference = (a: number[], b: number[]) => a.map((value, index) => value - b[index]!);
    const max = (values: number[]) => Math.max(...values.map(Math.abs));
    const h = 0.25;
    return tracks.map((animation) => {
      const effect = animation.effect as KeyframeEffect;
      const timing = effect.getTiming();
      const period = Number(timing.duration);
      const target = effect.target!;
      const at = (time: number) => {
        animation.currentTime = time;
        return pose(target);
      };
      const base = 2 * period + Number(timing.delay);
      const before = at(base - h),
        seam = at(base),
        after = at(base + h);
      const ownLeft = difference(seam, before).map((value) => value / h);
      const ownRight = difference(after, seam).map((value) => value / h);
      const zero = at(0),
        end = at(24000),
        endBefore = at(24000 - h),
        startAfter = at(h);
      const exportLeft = difference(end, endBefore).map((value) => value / h);
      const exportRight = difference(startAfter, zero).map((value) => value / h);
      return {
        name: (animation as CSSAnimation).animationName,
        period,
        ownEdgeStep: Math.max(max(difference(seam, before)), max(difference(after, seam))),
        ownVelocityJump: max(difference(ownLeft, ownRight)),
        exportPoseError: max(difference(zero, end)),
        exportVelocityJump: max(difference(exportLeft, exportRight)),
      };
    });
  });
  expect(new Set(proof.map((track) => track.name)).size).toBeGreaterThanOrEqual(9);
  for (const track of proof) {
    expect(24000 % track.period, track.name).toBe(0);
    expect(track.ownEdgeStep, track.name).toBeLessThan(0.002);
    expect(track.ownVelocityJump, track.name).toBeLessThan(0.002);
    expect(track.exportPoseError, track.name).toBeLessThan(0.0001);
    expect(track.exportVelocityJump, track.name).toBeLessThan(0.002);
  }
});

test("activity changes keep elapsed phase and interrupted fades settle to one layer", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/logo-avatars.html");
  const switcher = page
    .getByRole("region", { name: "Transitions and runtime events" })
    .locator("article")
    .first();
  const avatar = switcher.locator(".rakazo-logo-avatar[role=img]");
  await page.waitForTimeout(650);
  const timeBefore = await avatar.evaluate((element) =>
    Number(element.querySelector(".logo-avatar-scan")!.getAnimations()[0]!.currentTime),
  );
  const color = await avatar.getAttribute("data-color");
  for (const activity of ["Writing", "Thinking", "Computer use"]) {
    await switcher
      .getByRole("button", { name: activity, exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(300);
  await expect(avatar.locator("[data-logo-layer]")).toHaveCount(1);
  const timeAfter = await avatar.evaluate((element) =>
    Number(element.querySelector(".logo-avatar-scan")!.getAnimations()[0]!.currentTime),
  );
  expect(timeAfter).toBeGreaterThan(timeBefore + 250);
  expect(await avatar.getAttribute("data-color")).toBe(color);
  await expect(avatar).toHaveAttribute("data-activity", "computer");
});

test("writing keeps the head level with a small vertical typing cadence at avatar sizes", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/logo-avatars.html");
  await page
    .getByRole("button", { name: "Team: Writing", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await page.waitForTimeout(250);
  const proof = await page
    .locator('.rakazo-logo-avatar[data-activity="writing"][data-motion="true"]')
    .evaluateAll((avatars) =>
      avatars.map((avatar) => {
        const body = avatar.querySelector(".logo-avatar-body")!;
        const eyes = avatar.querySelector(".logo-avatar-scan")!;
        const bodyTrack = body.getAnimations()[0]!;
        const eyeTrack = eyes.getAnimations()[0]!;
        bodyTrack.pause();
        eyeTrack.pause();
        const period = Number(bodyTrack.effect!.getTiming().duration);
        const y: number[] = [];
        let maxAngle = 0,
          maxHeadX = 0,
          maxEyeX = 0;
        for (let time = 0; time <= period; time += 40) {
          bodyTrack.currentTime = time;
          eyeTrack.currentTime = time;
          const b = new DOMMatrix(getComputedStyle(body).transform);
          const e = new DOMMatrix(getComputedStyle(eyes).transform);
          maxAngle = Math.max(maxAngle, Math.abs(Math.atan2(b.b, b.a)));
          maxHeadX = Math.max(maxHeadX, Math.abs(b.e));
          maxEyeX = Math.max(maxEyeX, Math.abs(e.e));
          y.push(b.f);
        }
        return {
          size: Number(avatar.getAttribute("width")),
          maxAngle,
          maxHeadX,
          maxEyeX,
          yRange: Math.max(...y) - Math.min(...y),
        };
      }),
    );
  expect(proof.some((avatar) => avatar.size === 38)).toBe(true);
  expect(proof.some((avatar) => avatar.size === 32)).toBe(true);
  for (const avatar of proof) {
    expect(avatar.maxAngle).toBeLessThan(0.00001);
    expect(avatar.maxHeadX).toBeLessThan(0.00001);
    expect(avatar.maxEyeX).toBeLessThan(0.00001);
    expect(avatar.yRange).toBeGreaterThan(1.3);
    expect(avatar.yRange).toBeLessThanOrEqual(1.401);
  }
});

test("thinking ponders in one direction with a long squint and a small reconsideration", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/logo-avatars.html");
  await page
    .getByRole("button", { name: "Team: Thinking", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await page.waitForTimeout(250);
  const proof = await page
    .locator('.rakazo-logo-avatar[data-activity="thinking"][data-motion="true"]')
    .evaluateAll((avatars) =>
      avatars.map((avatar) => {
        const body = avatar.querySelector(".logo-avatar-body")!;
        const scan = avatar.querySelector(".logo-avatar-scan")!;
        const track = scan.getAnimations()[0]!;
        track.pause();
        const delay = Number(track.effect!.getTiming().delay);
        const at = (time: number) => {
          track.currentTime = time + delay + 24000;
          const matrix = new DOMMatrix(getComputedStyle(scan).transform);
          return [matrix.e, matrix.f];
        };
        const holds = [
          [0, 480],
          [1440, 2400],
          [3360, 3900],
          [4920, 5400],
        ].map(([start, end]) => [at(start! + 20), at(end! - 20)]);
        const main = at(1800),
          reconsider = at(3600),
          rest = at(6000);
        const lid = avatar.querySelector(".logo-avatar-eye-lid")!;
        const lidTrack = lid.getAnimations()[0]!;
        lidTrack.pause();
        const lidAt = (time: number) => {
          lidTrack.currentTime = time + delay + 24000;
          return new DOMMatrix(getComputedStyle(lid).transform).d;
        };
        return {
          size: Number(avatar.getAttribute("width")),
          bodyTracks: body.getAnimations().length,
          bodyTransform: getComputedStyle(body).transform,
          period: Number(track.effect!.getTiming().duration),
          holds,
          sameSide: main[0]! * reconsider[0]! > 0,
          mainOffset: Math.abs(main[0]!),
          smallerReconsideration: Math.abs(reconsider[0]!) < Math.abs(main[0]!),
          reconsiderLooksUp: reconsider[1]! < main[1]! - 1.5,
          rest,
          squint: [lidAt(1800), lidAt(3600), lidAt(6000)],
          eyeCenters: [...avatar.querySelectorAll(".logo-avatar-eye ellipse:first-child")].map(
            (eye) => Number(eye.getAttribute("cx")),
          ),
        };
      }),
    );
  expect(proof.some((avatar) => avatar.size === 38)).toBe(true);
  expect(proof.some((avatar) => avatar.size === 32)).toBe(true);
  for (const avatar of proof) {
    expect(avatar.bodyTracks).toBe(0);
    expect(avatar.bodyTransform).toBe("none");
    expect(avatar.period).toBe(6000);
    expect(avatar.sameSide).toBe(true);
    expect(avatar.mainOffset).toBe(9);
    expect(avatar.smallerReconsideration).toBe(true);
    expect(avatar.reconsiderLooksUp).toBe(true);
    expect(avatar.rest).toEqual([0, -2]);
    expect(avatar.squint).toEqual([0.8, 0.68, 1]);
    expect(avatar.eyeCenters).toEqual([40.5, 59.5]);
    for (const [start, end] of avatar.holds) expect(start).toEqual(end);
  }
});

test("paired blinks last 160ms with uneven spacing and reduced motion opens the eyes", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/logo-avatars.html");
  const proof = await page
    .getByTestId("same-state-bots")
    .getByRole("img")
    .evaluateAll((avatars) =>
      avatars.map((avatar) => {
        const eyes = [...avatar.querySelectorAll(".logo-avatar-eye")];
        const tracks = eyes.map((eye) => eye.getAnimations()[0]!);
        const frames = (tracks[0]!.effect as KeyframeEffect).getKeyframes();
        const period = Number(tracks[0]!.effect!.getTiming().duration);
        const closed = frames.flatMap((frame, index) =>
          String(frame.transform).includes("0.06") &&
          !String(frames[index - 1]?.transform).includes("0.06")
            ? [index]
            : [],
        );
        const starts = closed.map((index) => frames[index - 1]!.computedOffset * period);
        const durations = closed.map(
          (index) =>
            (frames[index + 2]!.computedOffset - frames[index - 1]!.computedOffset) * period,
        );
        return {
          period,
          count: closed.length,
          durations,
          gaps: starts.map(
            (start, index) => (starts[(index + 1) % starts.length]! - start + period) % period,
          ),
          paired:
            JSON.stringify((tracks[0]!.effect as KeyframeEffect).getKeyframes()) ===
              JSON.stringify((tracks[1]!.effect as KeyframeEffect).getKeyframes()) &&
            tracks[0]!.effect!.getTiming().delay === tracks[1]!.effect!.getTiming().delay,
        };
      }),
    );
  expect(new Set(proof.map((bot) => bot.count))).toEqual(new Set([3, 4]));
  for (const bot of proof) {
    expect(bot.period).toBe(24000);
    expect(bot.paired).toBe(true);
    expect(new Set(bot.gaps.map(Math.round)).size).toBe(bot.count);
    for (const duration of bot.durations) expect(duration).toBeCloseTo(160, 2);
  }
  const eye = page
    .getByRole("img", { name: "Thinking", exact: true })
    .locator(".logo-avatar-eye")
    .first();
  await eye.evaluate((node) => {
    const animation = node.getAnimations()[0]!;
    animation.pause();
    const effect = animation.effect as KeyframeEffect;
    const frame = effect.getKeyframes().find((frame) => String(frame.transform).includes("0.06"))!;
    animation.currentTime = frame.computedOffset * 24000 + Number(effect.getTiming().delay) + 24000;
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(eye).toHaveCSS("animation-name", "none");
  await expect(eye).toHaveCSS("transform", "none");
});

test("expressive gaze reads at24/32/38px and stays on the logo silhouette", async ({ page }) => {
  await page.goto("/e2e/fixtures/logo-avatars.html?compare=1");
  const proof = await page.evaluate(async () => {
    const avatars = [...document.querySelectorAll<SVGSVGElement>(".rakazo-logo-avatar")].filter(
      (avatar) =>
        [24, 32, 38].includes(Number(avatar.getAttribute("width"))) &&
        avatar.dataset.activity !== "idle",
    );
    return avatars.map((avatar) => {
      const scan = avatar.querySelector<SVGGElement>(".logo-avatar-scan")!;
      const imageElement = avatar.querySelector<SVGPathElement>(".logo-avatar-art > path")!;
      const eyes = [
        ...avatar.querySelectorAll<SVGEllipseElement>(".logo-avatar-eye ellipse:first-child"),
      ];
      const tracks = avatar.getAnimations({ subtree: true });
      tracks.forEach((track) => {
        track.pause();
      });
      const movement = scan.getAnimations()[0]!;
      const period = Number(movement.effect!.getTiming().duration);
      const origin = Number(movement.effect!.getTiming().delay) + 24000;
      const centers: { x: number; y: number }[] = [];
      let minAlpha = 255,
        maxSpacingError = 0;
      for (let time = 0; time <= period; time += 40) {
        tracks.forEach((track) => {
          track.currentTime = origin + time;
        });
        const bounds = eyes.map((eye) => eye.getBoundingClientRect());
        centers.push({
          x: bounds[0]!.x + bounds[0]!.width / 2,
          y: bounds[0]!.y + bounds[0]!.height / 2,
        });
        maxSpacingError = Math.max(
          maxSpacingError,
          Math.abs(
            bounds[1]!.x +
              bounds[1]!.width / 2 -
              (bounds[0]!.x + bounds[0]!.width / 2) -
              (19 * Number(avatar.getAttribute("width"))) / 100,
          ),
        );
        for (const eye of eyes) {
          const intoArtwork = imageElement.getCTM()!.inverse().multiply(eye.getCTM()!);
          for (let angle = 0; angle < 16; angle++) {
            const point = new DOMPoint(
              Number(eye.getAttribute("cx")) + 5.2 * Math.cos((angle * Math.PI) / 8),
              40 + 8 * Math.sin((angle * Math.PI) / 8),
            ).matrixTransform(intoArtwork);
            minAlpha = Math.min(
              minAlpha,
              imageElement.isPointInFill(new DOMPoint(point.x, point.y)) ? 255 : 0,
            );
          }
        }
      }
      return {
        activity: avatar.dataset.activity!,
        size: Number(avatar.getAttribute("width")),
        animated: avatar.dataset.motion,
        xRange: Math.max(...centers.map((p) => p.x)) - Math.min(...centers.map((p) => p.x)),
        yRange: Math.max(...centers.map((p) => p.y)) - Math.min(...centers.map((p) => p.y)),
        minAlpha,
        maxSpacingError,
      };
    });
  });
  expect(new Set(proof.map((item) => item.size))).toEqual(new Set([24, 32, 38]));
  for (const item of proof) {
    expect(item.animated).toBe("true");
    expect(item.minAlpha, `${item.activity} eye silhouette`).toBeGreaterThanOrEqual(245);
    expect(item.maxSpacingError).toBeLessThan(0.01);
    if (item.activity === "writing") {
      expect(item.xRange).toBeLessThan(0.01);
      expect(item.yRange).toBeGreaterThan((1.3 * item.size) / 24);
    } else if (item.activity === "thinking") {
      expect(item.xRange).toBeGreaterThan((1.8 * item.size) / 24);
      expect(item.yRange).toBeGreaterThan((1.8 * item.size) / 24);
    } else {
      expect(item.xRange, `${item.activity} ${item.size}px gaze travel`).toBeGreaterThan(
        (4 * item.size) / 24,
      );
    }
  }
});

test("reading advances lines, typing taps keys, and computer use follows a cursor selection", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/logo-avatars.html");
  for (const name of ["Reading", "Writing", "Thinking", "Computer use"]) {
    const avatar = page.getByRole("img", { name, exact: true });
    await expect(avatar.locator("image")).toHaveCount(0);
    await expect(avatar).toHaveAttribute("data-vector-body", "true");
    await expect(avatar.locator("image, filter, feGaussianBlur")).toHaveCount(0);
  }
  const proof = await page
    .getByRole("region", { name: "Requested expressions" })
    .evaluate((region) => {
      const sample = (activity: string, fraction: number) => {
        const avatar = region.querySelector(`[data-activity="${activity}"]`)!;
        const scan = avatar.querySelector(".logo-avatar-scan")!;
        const movement = scan.getAnimations()[0]!;
        const timing = movement.effect!.getTiming();
        const time = 24000 + Number(timing.delay) + Number(timing.duration) * fraction;
        avatar.getAnimations({ subtree: true }).forEach((track) => {
          track.pause();
          track.currentTime = time;
        });
        const position = (selector: string) => {
          const style = getComputedStyle(avatar.querySelector(selector)!);
          const m = new DOMMatrix(style.transform);
          return [m.e, m.f, Number(style.opacity)];
        };
        return {
          gaze: position(".logo-avatar-scan"),
          pointer: activity === "computer" ? position(".logo-avatar-pointer") : null,
          selected: activity === "computer" ? position(".logo-avatar-selection")[2] : null,
          keyLeft: activity === "writing" ? position(".logo-avatar-key-left")[2] : null,
          keyRight: activity === "writing" ? position(".logo-avatar-key-right")[2] : null,
        };
      };
      return {
        reading: [0, 0.26, 0.36, 0.56, 0.66, 0.86, 1].map((t) =>
          sample("reading", t).gaze.slice(0, 2),
        ),
        typing: [0.18, 0.4, 0.64].map((t) => sample("writing", t)),
        computer: [0.25, 0.6].map((t) => sample("computer", t)),
        cueClasses: ["reading", "writing", "computer"].map((activity) =>
          region
            .querySelector(`[data-activity="${activity}"] .logo-avatar-task`)!
            .getAttribute("class"),
        ),
      };
    });
  expect(proof.reading).toEqual([
    [0, 0],
    [20, 0],
    [0, 5],
    [20, 5],
    [0, 10],
    [20, 10],
    [0, 0],
  ]);
  expect(proof.typing[0]!.keyLeft).toBe(1);
  expect(proof.typing[1]!.gaze.slice(0, 2)).toEqual([0, 0]);
  expect(proof.typing[2]!.keyRight).toBe(1);
  expect(proof.typing[2]!.gaze[1]).toBe(6);
  expect(proof.computer[0]!.gaze.slice(0, 2)).toEqual([10, -3]);
  expect(proof.computer[0]!.pointer!.slice(0, 2)).toEqual([18, 0]);
  expect(proof.computer[1]!.gaze.slice(0, 2)).toEqual([-8, 6]);
  expect(proof.computer[1]!.pointer!.slice(0, 2)).toEqual([7, 2]);
  expect(proof.computer[1]!.selected).toBe(0.85);
  expect(new Set(proof.cueClasses).size).toBe(3);
});

test("native small-size indicators keep one-pixel strokes and omit fine detail in both themes", async ({
  page,
}) => {
  for (const theme of ["dark", "light"]) {
    await page.goto(`/e2e/fixtures/logo-avatars.html?strip=1&theme=${theme}`);
    const proof = await page.locator(".rakazo-logo-avatar").evaluateAll((avatars) =>
      avatars.map((avatar) => {
        const size = Number(avatar.getAttribute("width"));
        const bounds = avatar.getBoundingClientRect();
        const task = avatar.querySelector(".logo-avatar-task");
        return {
          size,
          width: bounds.width,
          height: bounds.height,
          strokePixels: task
            ? (Number.parseFloat(getComputedStyle(task).strokeWidth) * size) / 100
            : null,
          hiddenDetails: [...avatar.querySelectorAll(".logo-avatar-task-detail")].every(
            (node) => getComputedStyle(node).display === "none",
          ),
        };
      }),
    );
    expect(new Set(proof.map((item) => item.size))).toEqual(new Set([24, 32, 38]));
    for (const item of proof) {
      expect(item.width).toBe(item.size);
      expect(item.height).toBe(item.size);
      expect(item.hiddenDetails).toBe(true);
      if (item.strokePixels !== null) {
        expect(item.strokePixels).toBeGreaterThanOrEqual(0.999);
        expect(item.strokePixels).toBeLessThanOrEqual(1.001);
      }
    }
  }
});

test("directional vector rim follows the source edge falloff without whitening the face", async ({
  page,
}) => {
  const original = await readFile(
    new URL(
      "../../../packages/ui-tokens/assets/Rakazo.icon/Assets/orange-bot.png",
      import.meta.url,
    ),
  );
  await page.goto("/e2e/fixtures/logo-avatars.html?compare=1&theme=light");
  const art = await page
    .getByRole("img", { name: "Idle", exact: true })
    .locator(".logo-avatar-art")
    .evaluate((node) => node.outerHTML);
  const proof = await page.evaluate(
    async ({ art, original }) => {
      const pixels = async (src: string) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1024;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0, 1024, 1024);
        return context.getImageData(0, 0, 1024, 1024).data;
      };
      const source = await pixels(original);
      const vector = await pixels(
        `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100">${art}</svg>`)}`,
      );
      const rgba = (data: Uint8ClampedArray, x: number, y: number) =>
        Array.from(data.slice((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4));
      const y = 420;
      const opaque = Array.from({ length: 1024 }, (_, x) => x).filter(
        (x) => rgba(source, x, y)[3]! > 245,
      );
      const left = opaque[0]!,
        right = opaque[opaque.length - 1]!;
      const sample = (data: Uint8ClampedArray, side: "left" | "right", inset: number) =>
        rgba(data, side === "left" ? left + inset : right - inset, y);
      return {
        sourceLeft: sample(source, "left", 4),
        vectorLeft: sample(vector, "left", 4),
        sourceRight: sample(source, "right", 4),
        vectorRight: sample(vector, "right", 4),
        leftInside: sample(vector, "left", 40),
        rightInside: sample(vector, "right", 40),
        sourceHotspot: rgba(source, 580, 220),
        vectorHotspot: rgba(vector, 580, 220),
        outsideAlpha: rgba(vector, 512, 20)[3],
      };
    },
    { art, original: `data:image/png;base64,${original.toString("base64")}` },
  );
  expect(proof.vectorRight[2]! - proof.rightInside[2]!).toBeGreaterThan(25);
  expect(proof.vectorLeft[2]! - proof.leftInside[2]!).toBeGreaterThan(15);
  expect(proof.vectorRight[1]! - proof.vectorLeft[1]!).toBeGreaterThan(25);
  for (const [actual, source] of [
    [proof.vectorLeft, proof.sourceLeft],
    [proof.vectorRight, proof.sourceRight],
    [proof.vectorHotspot, proof.sourceHotspot],
  ])
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(actual![channel]! - source![channel]!)).toBeLessThan(30);
  expect(proof.outsideAlpha).toBe(0);
});

test("seed colours persist through rerenders and reloads at actual avatar sizes", async ({
  page,
}, testInfo) => {
  for (const theme of ["light", "dark"]) {
    await page.goto(`/e2e/fixtures/logo-avatars.html?seeded=1&count=18&theme=${theme}`);
    const avatars = page.getByTestId("seeded-fleet").locator(".rakazo-logo-avatar");
    await expect(avatars).toHaveCount(72);
    const before = await avatars.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-color")),
    );
    // Seeds pick from the shared palette, so 18 bots can share colours but never all one.
    for (const color of before) expect(BOT_COLORS).toContain(color);
    expect(new Set(before).size).toBeGreaterThan(1);
    for (let index = 0; index < 18; index++)
      expect(new Set(before.slice(index * 4, index * 4 + 4)).size).toBe(1);
    await page.getByRole("button", { name: "Rerender fleet" }).click();
    await expect(page.locator("main")).toHaveAttribute("data-renders", "1");
    expect(
      await avatars.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-color"))),
    ).toEqual(before);
    await page.reload();
    await expect(avatars).toHaveCount(72);
    expect(
      await avatars.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-color"))),
    ).toEqual(before);
    await captureScreenshot(page, testInfo, `seeded-avatar-colours-${theme}`);
  }
});

test("new activity does not restart an existing outgoing fade", async ({ page }) => {
  await page.goto("/e2e/fixtures/logo-avatars.html");
  const switcher = page
    .getByRole("region", { name: "Transitions and runtime events" })
    .locator("article")
    .first();
  await switcher.scrollIntoViewIfNeeded();
  await expect(switcher.locator(".rakazo-logo-avatar[role=img]")).toHaveAttribute(
    "data-paused",
    "false",
  );
  const proof = await switcher.evaluate(async (article) => {
    const avatar = article.querySelector(".rakazo-logo-avatar[role=img]")!;
    const change = (name: string, activity: string) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(new Error("Activity did not commit"));
        }, 5000);
        const observer = new MutationObserver(() => {
          if (
            avatar.querySelector(
              `[data-logo-layer][data-outgoing="false"][data-activity="${activity}"]`,
            )
          ) {
            observer.disconnect();
            clearTimeout(timeout);
            resolve();
          }
        });
        observer.observe(avatar, { childList: true, subtree: true, attributes: true });
        [...article.querySelectorAll("button")]
          .find((button) => button.textContent === name)!
          .click();
      });
    await change("Writing", "writing");
    const outgoing = avatar.querySelector<SVGGElement>('[data-outgoing="true"]')!;
    const fade = outgoing
      .getAnimations()
      .find((animation) => (animation as CSSAnimation).animationName === "logo-avatar-layer-out")!;
    fade.pause();
    await fade.ready;
    fade.currentTime = 90;
    const before = {
      time: Number(fade.currentTime),
      from: outgoing.style.getPropertyValue("--logo-exit-from"),
    };
    await change("Thinking", "thinking");
    const after = {
      time: Number(fade.currentTime),
      from: outgoing.style.getPropertyValue("--logo-exit-from"),
    };
    const key = outgoing.dataset.logoLayer!;
    fade.finish();
    return { before, after, key };
  });
  expect(proof.after.time).toBeGreaterThanOrEqual(proof.before.time - 0.01);
  expect(proof.after.from).toBe(proof.before.from);
  await expect(switcher.locator(`[data-logo-layer="${proof.key}"]`)).toHaveCount(0);
});
