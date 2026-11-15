import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("photo working avatars show a visible ring while idle avatars stay plain", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html");

  const working = page.locator(".avatar-working");
  await expect(working).toBeVisible();
  await expect(working).toHaveAttribute("data-working", "true");
  const picture = working.locator(".rakazo-bot-avatar-picture");
  const ring = working.locator(".rakazo-bot-avatar-ring");
  await expect(picture).toBeVisible();
  await expect(ring).toBeVisible();

  const overflow = await working.evaluate((el) => getComputedStyle(el).overflowX);
  const pictureOverflow = await picture.evaluate((el) => getComputedStyle(el).overflowX);
  const ringAnimation = await ring.evaluate((el: SVGElement) => getComputedStyle(el).animationName);
  const ringColor = await ring.locator("circle").evaluate((el) => getComputedStyle(el).stroke);
  const pictureAnimation = await picture.evaluate((el) => getComputedStyle(el).animationName);
  const workingColor = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--status-working)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(overflow).not.toBe("hidden");
  expect(pictureOverflow).toBe("hidden");
  expect(ringAnimation).toBe("rakazo-avatar-spin");
  expect(ringColor).toBe(workingColor);
  expect(pictureAnimation).toBe("rakazo-avatar-breathe");
  const firstPictureTransform = await picture.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(300);
  const secondPictureTransform = await picture.evaluate((el) => getComputedStyle(el).transform);
  expect(secondPictureTransform).not.toBe(firstPictureTransform);

  const idle = page.locator(".avatar-idle");
  await expect(idle).toHaveAttribute("data-working", "false");
  await expect(idle.locator(".rakazo-bot-avatar-ring")).toHaveCount(0);
  await expect(idle.locator(".rakazo-bot-avatar-picture")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".avatar-shape-idle .rakazo-bot-avatar-ring")).toHaveCSS(
    "animation-play-state",
    "paused",
  );
  await captureScreenshot(page, testInfo, "avatar-photo-working-and-idle");
});

test("photo avatar animations stay still when reduced motion is enabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/e2e/fixtures/avatar-motion.html");

  const avatar = page.locator(".avatar-working");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("data-working", "true");

  const ring = avatar.locator(".rakazo-bot-avatar-ring");
  const picture = avatar.locator(".rakazo-bot-avatar-picture");
  await expect(ring).toBeVisible();
  const snapshot = () =>
    Promise.all([
      ring.evaluate((el: SVGElement) => ({
        animationName: getComputedStyle(el).animationName,
        transform: getComputedStyle(el).transform,
      })),
      picture.evaluate((el) => ({
        animationName: getComputedStyle(el).animationName,
        transform: getComputedStyle(el).transform,
      })),
    ]);
  const first = await snapshot();
  await page.waitForTimeout(300);
  const second = await snapshot();

  expect(first[0]?.animationName).toBe("none");
  expect(first[1]?.animationName).toBe("none");
  expect(second).toEqual(first);
});

test("organic avatars hold still while idle and stop working motion while offscreen or hidden", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html");
  const avatar = page.locator(".avatar-organic");
  await expect(avatar).toBeVisible();
  const motion = () =>
    avatar.evaluate((svg: SVGSVGElement) => {
      const states = (mode: string) =>
        [
          ...svg.querySelectorAll(
            `.rakazo-organic-avatar-body-${mode}, .rakazo-organic-avatar-eyes-${mode}`,
          ),
        ].flatMap((element) =>
          element
            .getAnimations()
            .filter((track) => track instanceof CSSAnimation)
            .map((track) => track.playState),
        );
      return {
        clockPaused: svg.animationsPaused(),
        morphing: ["idle", "working"].filter((mode) =>
          svg.querySelector(`.rakazo-organic-avatar-body-${mode} animate`),
        ),
        idle: [...new Set(states("idle"))],
        working: [...new Set(states("working"))],
      };
    });
  // Idle avatars draw no frames: SVG motion repaints on the main thread.
  expect(await motion()).toEqual({
    clockPaused: false,
    morphing: [],
    idle: [],
    working: ["paused"],
  });
  const clock = await avatar.evaluate((svg: SVGSVGElement) => svg.getCurrentTime());
  await page.waitForTimeout(400);
  expect(await avatar.evaluate((svg: SVGSVGElement) => svg.getCurrentTime())).toBeGreaterThan(
    clock,
  );

  // The working morph joins the running svg clock instead of restarting it, and fades in.
  const handoff = await avatar.evaluate(async (svg: SVGSVGElement) => {
    const body = (mode: string) =>
      svg.querySelector<SVGPathElement>(`.rakazo-organic-avatar-body-${mode}`)!;
    const before = svg.getCurrentTime();
    svg.parentElement!.querySelector("button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      before,
      time: svg.getCurrentTime(),
      start: body("working").querySelector("animate")?.getStartTime(),
      fading: body("working")
        .getAnimations()
        .some((track) => track instanceof CSSTransition && track.transitionProperty === "opacity"),
    };
  });
  expect(handoff.time).toBeGreaterThanOrEqual(handoff.before);
  expect(handoff.start).toBeLessThan(handoff.before);
  expect(handoff.fading).toBe(true);
  await expect(avatar).toHaveAttribute("data-working", "true");
  expect(await motion()).toEqual({
    clockPaused: false,
    morphing: ["working"],
    idle: [],
    working: ["running"],
  });

  const stopped = {
    clockPaused: true,
    morphing: ["working"],
    idle: [],
    working: ["paused"],
  };
  await avatar.evaluate((svg) => {
    svg.closest<HTMLElement>(".avatar-example")!.style.marginTop = "2200px";
  });
  await expect(avatar).toHaveAttribute("data-paused", "true");
  expect(await motion()).toEqual(stopped);
  await avatar.evaluate((svg) => {
    svg.closest<HTMLElement>(".avatar-example")!.style.marginTop = "0";
  });
  await expect(avatar).toHaveAttribute("data-paused", "false");

  const setHidden = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await setHidden(true);
  await expect(avatar).toHaveAttribute("data-paused", "true");
  expect(await motion()).toEqual(stopped);
  await setHidden(false);
  await expect(avatar).toHaveAttribute("data-paused", "false");
  expect((await motion()).clockPaused).toBe(false);
});
