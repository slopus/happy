import { describe, expect, it } from "vitest";
import { renderIosScreenshotGallery } from "./ios-screenshot-gallery.js";

describe("iOS screenshot gallery", () => {
  it("renders a sticky sidebar, name filter, section anchors, and click-to-enlarge", () => {
    const html = renderIosScreenshotGallery([
      {
        id: "settings",
        title: "Settings",
        shots: [{ name: "01-account.png", src: "settings/01-account.png" }],
      },
      { id: "auth", title: "Auth & <welcome>", shots: [] },
    ]);
    expect(html).toContain("position: sticky");
    expect(html).toContain('id="filter"');
    expect(html).toContain('placeholder="Filter screenshot names"');
    expect(html).toContain('href="#settings"');
    expect(html).toContain('id="settings"');
    expect(html).toContain('id="auth"');
    expect(html).toContain("settings/01-account.png");
    expect(html).toContain("showModal");
    expect(html).toContain("Auth &amp; &lt;welcome&gt;");
    expect(html).not.toContain("Auth & <welcome>");
  });
});
