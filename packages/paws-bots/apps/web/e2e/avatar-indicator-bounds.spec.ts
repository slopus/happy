import { expect, test } from "@playwright/test";
import { auditIndicatorBounds } from "./helpers/avatar-indicator-raster.js";

test.use({ viewport: { width: 1120, height: 350 }, deviceScaleFactor: 1 });
for (const theme of ["dark", "light"])
  for (const activity of ["reading", "writing", "computer"]) {
    test(`${activity} painted content stays inside its actual geometry in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.goto(`/e2e/fixtures/logo-avatars.html?compare=1&same=${activity}&theme=${theme}`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      const proof = await page.evaluate(auditIndicatorBounds, { theme, activity });
      expect(proof.actors).toBe(18);
      expect(proof.colours).toHaveLength(6);
      expect(new Set(proof.sizes)).toEqual(new Set([24, 32, 38]));
      expect(proof.frames).toBe(10800);
      expect(proof.visiblePixels).toBeGreaterThan(100000);
      expect(proof.outsidePixels).toBe(0);
      expect(proof.maxAlphaOnEmptyMask).toBe(0);
      expect(proof.safeOutsideSurface).toBe(0);
      await testInfo.attach(`${activity}-${theme}-raster-bounds`, {
        body: JSON.stringify(proof, null, 2),
        contentType: "application/json",
      });
    });
  }
