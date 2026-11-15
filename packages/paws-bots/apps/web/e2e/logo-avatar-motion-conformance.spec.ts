import { expect, test } from "@playwright/test";
import type { LogoAvatarActivity } from "../../../packages/core/src/logo-avatar-activity";
import type { LogoAvatarFrame } from "../../../packages/core/src/logo-avatar-motion";
import { logoAvatarFrame } from "../../../packages/core/src/logo-avatar-motion";
import { logoAvatarTraits } from "../../../packages/core/src/logo-avatar-traits";

const identities = ["inbox-01", "scout-02", "studio-03", "atlas-04", "ledger-05", "muse-06"];
// Web idle avatars hold still (SVG motion repaints on the main thread), so idle is not sampled.
const activities = ["reading", "writing", "thinking", "computer"] as const;
test.use({ viewport: { width: 1260, height: 1120 } });

for (const activity of activities)
  test(`${activity} CSS matches the shared native sampler across seeded phases and themes`, async ({
    page,
  }, testInfo) => {
    let checks = 0,
      maxError = 0;
    for (const theme of ["dark", "light"])
      for (const reduced of [false, true]) {
        await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        await page.goto(
          `/e2e/fixtures/logo-avatars.html?compare=1&same=${activity}&theme=${theme}`,
        );
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.waitForTimeout(220);
        const cards = page
          .getByRole("region", { name: "Avatar size comparison" })
          .locator("article");
        await expect(cards).toHaveCount(6);
        for (let index = 0; index < identities.length; index++) {
          const avatar = cards.nth(index).locator('.rakazo-logo-avatar[width="104"]');
          await expect(avatar).toHaveAttribute("data-activity", activity);
          const color = (await avatar.getAttribute("data-color"))!;
          const traits = logoAvatarTraits(identities[index]!, color);
          const period = traits.periods[activity];
          const delay = -Math.round(period * traits.phase * 1000) / 1000;
          const wrap = (time: number) => ((time % 24000) + 24000) % 24000;
          const times = reduced
            ? [0, 23999]
            : [
                ...new Set([
                  0,
                  31,
                  235,
                  777,
                  1111,
                  1731,
                  4013,
                  7117,
                  11589,
                  23999,
                  ...[
                    0, 0.08, 0.18, 0.24, 0.26, 0.32, 0.4, 0.48, 0.56, 0.6, 0.65, 0.76, 0.82, 0.9,
                    0.96, 1,
                  ].map((f) => wrap(delay + f * period)),
                  ...[0, 50, 70, 160].map((offset) =>
                    wrap(
                      traits.blinkDelayMs +
                        (traits.blinkVariant === "three" ? 4100 : 3200) +
                        offset,
                    ),
                  ),
                ]),
              ];
          const actual = await avatar.evaluate(
            (node, input) => {
              const tracks = node
                .getAnimations({ subtree: true })
                .filter((track) => track.effect?.getTiming().iterations === Infinity);
              tracks.forEach((track) => {
                track.pause();
              });
              const matrix = (selector: string) =>
                new DOMMatrix(getComputedStyle(node.querySelector(selector)!).transform);
              const opacity = (selector: string) =>
                Number(getComputedStyle(node.querySelector(selector)!).opacity);
              return input.times.map((time) => {
                tracks.forEach((track) => {
                  track.currentTime = time;
                });
                const gaze = matrix(".logo-avatar-gaze"),
                  scan = matrix(".logo-avatar-scan"),
                  lid = matrix(".logo-avatar-eye-lid"),
                  blink = matrix(".logo-avatar-eye"),
                  body = matrix(".logo-avatar-body");
                const frame: Record<string, number> = {
                  eyeX: gaze.e + scan.e,
                  eyeY: gaze.f + scan.f,
                  lid: lid.d,
                  blink: blink.d,
                  bodyY: body.f,
                  bodyScale: body.a,
                };
                if (input.activity === "reading") {
                  const marker = matrix(".logo-avatar-page-cursor");
                  frame.pageX = marker.e;
                  frame.pageY = marker.f;
                }
                if (input.activity === "writing") {
                  const left = matrix(".logo-avatar-key-left"),
                    right = matrix(".logo-avatar-key-right");
                  frame.keyLeft = opacity(".logo-avatar-key-left");
                  frame.keyRight = opacity(".logo-avatar-key-right");
                  frame.keyLeftY = left.f;
                  frame.keyRightY = right.f;
                }
                if (input.activity === "computer") {
                  const pointer = matrix(".logo-avatar-pointer");
                  frame.pointerX = pointer.e;
                  frame.pointerY = pointer.f;
                  frame.selection = opacity(".logo-avatar-selection");
                }
                return { time, frame };
              });
            },
            { activity, times },
          );
          for (const row of actual) {
            const expected = logoAvatarFrame(
              activity as LogoAvatarActivity,
              traits,
              row.time,
              reduced,
            );
            for (const [key, value] of Object.entries(row.frame)) {
              const error = Math.abs(value - expected[key as keyof LogoAvatarFrame]);
              checks++;
              maxError = Math.max(maxError, error);
              expect(
                error,
                `${activity}/${theme}/${identities[index]}/${reduced ? "reduced" : "motion"}/${row.time}/${key}`,
              ).toBeLessThan(0.001);
            }
          }
        }
      }
    await testInfo.attach("shared-motion-conformance", {
      body: JSON.stringify({ checks, maxError }),
      contentType: "application/json",
    });
  });
