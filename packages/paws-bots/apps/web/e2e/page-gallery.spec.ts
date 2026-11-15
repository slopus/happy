import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { pageViewerCode } from "../../../packages/page-kit/src/compile";
import { buildPageRuntime } from "../../../packages/page-kit/src/runtime-build";

const photos = ["First", "Second", "Third"].map((alt, index) => ({
  alt,
  src: `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="hsl(${index * 110} 60% 50%)"/></svg>`,
  ).toString("base64")}`,
}));

// The page runtime the app serves to sandboxed pages, with a page of three photos in each language.
let runtime = "";
test.beforeAll(async () => {
  runtime = await buildPageRuntime();
});
test.use({ viewport: { width: 700, height: 600 }, reducedMotion: "reduce" });

async function openGallery(page: Page, lang: string) {
  const source = `export default function Trip() {
    return <Page title="Trip" lang="${lang}"><Gallery photos={${JSON.stringify(photos)}} /></Page>;
  }`;
  const boot = JSON.stringify({
    code: pageViewerCode(source),
    theme: "light",
    errorTitle: "Error",
    lang,
  });
  await page.setContent(
    `<!doctype html><html><body><div id="root"></div><script>${runtime.replaceAll("</script", "<\\/script")}</script><script>RakazoPage.mount(${boot.replaceAll("<", "\\u003c")});</script></body></html>`,
  );
  const track = page.locator(".rk-gallery-track");
  await expect(track).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("dir", lang === "he" ? "rtl" : "ltr");
  return track;
}

/** The photo on screen, read from where the slides really sit, never from the scroll offset. */
async function shown(track: Locator) {
  return track.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const covered = [...node.querySelectorAll(".rk-gallery-slide")].map((slide) => {
      const rect = slide.getBoundingClientRect();
      const width = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
      return { alt: slide.querySelector("img")?.alt, width, offset: rect.left - box.left };
    });
    const best = covered.reduce((a, b) => (b.width > a.width ? b : a));
    return best.width >= box.width - 1 && Math.abs(best.offset) <= 1 ? best.alt : undefined;
  });
}

/** Scrolls to a photo by where its slide sits, as a reader's swipe would. */
async function scrollTo(track: Locator, index: number) {
  await track.evaluate((node, at) => {
    const slide = node.querySelectorAll(".rk-gallery-slide")[at]!;
    node.scrollLeft += slide.getBoundingClientRect().left - node.getBoundingClientRect().left;
  }, index);
}

const dots = (page: Page) => page.locator(".rk-gallery-dots button");

/** Exactly one dot is current, and it is this one. */
async function expectMarked(page: Page, index: number) {
  await expect(page.locator(".rk-gallery-dots button[aria-current]")).toHaveCount(1);
  await expect(dots(page).nth(index)).toHaveAttribute("aria-current", "true");
}

for (const { lang, label, next, previous } of [
  { lang: "en", label: "English", next: "ArrowRight", previous: "ArrowLeft" },
  { lang: "he", label: "Hebrew", next: "ArrowLeft", previous: "ArrowRight" },
]) {
  test.describe(`${label} page gallery`, () => {
    test("a dot brings its photo into view and is the only one marked", async ({ page }) => {
      const track = await openGallery(page, lang);
      await expect(dots(page)).toHaveCount(3);
      expect(await shown(track)).toBe("First");
      await expectMarked(page, 0);
      for (const index of [1, 2, 0]) {
        await dots(page).nth(index).click();
        await expect.poll(() => shown(track)).toBe(photos[index]!.alt);
        await expectMarked(page, index);
      }
    });

    test("scrolling to a photo marks its dot and never leaves none", async ({ page }) => {
      const track = await openGallery(page, lang);
      for (const index of [1, 2, 1, 0]) {
        await scrollTo(track, index);
        expect(await shown(track)).toBe(photos[index]!.alt);
        await expectMarked(page, index);
      }
    });

    test("arrow keys follow the way the photos lie and stop at both ends", async ({ page }) => {
      const track = await openGallery(page, lang);
      await track.focus();
      await page.keyboard.press(previous);
      expect(await shown(track)).toBe("First");
      await expectMarked(page, 0);
      for (const [index, alt] of [
        [1, "Second"],
        [2, "Third"],
        [2, "Third"],
      ] as const) {
        await page.keyboard.press(next);
        await expect.poll(() => shown(track)).toBe(alt);
        await expectMarked(page, index);
      }
      await page.keyboard.press(previous);
      await expect.poll(() => shown(track)).toBe("Second");
      await expectMarked(page, 1);
    });
  });
}
