import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { contrastRatio, seededLogoAvatarColor } from "@rakazo/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotAvatar } from "./bot-avatar.js";
import { LogoAvatar } from "./logo-avatar.js";

describe("logo-derived avatar prototype", () => {
  it("uses the shared identity colour during SSR when no saved choice is supplied", () => {
    for (const identity of ["seed-bot-1", "seed-bot-2"]) {
      const expected = seededLogoAvatarColor(identity);
      expect(renderToString(<LogoAvatar identity={identity} />)).toContain(
        `data-color="${expected}"`,
      );
      expect(
        renderToString(<BotAvatar color="" identity={identity} avatarSet="rakazo" />),
      ).toContain(`data-color="${expected}"`);
    }
  });
  it("renders the eye-free brand body with vector eyes and an accessible name", () => {
    const html = renderToString(<LogoAvatar activity="reading" label="Inbox is reading" />);
    expect(html).toContain('data-vector-body="true"');
    expect(html).not.toContain("<image");
    expect(html).not.toContain("<filter");
    // The two light windows contain vector gradients only, never an image or baked eyes.
    expect([...html.matchAll(/<mask\b/g)]).toHaveLength(2);
    expect(html).toContain("mask-type:luminance");
    expect(html).not.toContain("orange-bot.png");
    expect(html).toContain("logo-avatar-gaze");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Inbox is reading"');
  });

  it("gives repeated avatars unique local mask and gradient references", () => {
    const html = renderToString(
      <>
        <LogoAvatar />
        <LogoAvatar />
      </>,
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(4);
  });

  it.each([16, 20])("keeps %spx avatars still", (size) => {
    const html = renderToString(<LogoAvatar activity="writing" size={size} />);
    expect(html).toContain('data-motion="false"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("leaves an uploaded avatar intact", () => {
    const html = renderToString(<BotAvatar color="data:image/png;base64,abc" avatarSet="rakazo" />);
    expect(html).toContain('src="data:image/png;base64,abc"');
    expect(html).not.toContain("bot-avatar-body.png");
  });

  it("leaves a manually selected shape intact", () => {
    const html = renderToString(<BotAvatar color="#8B5CF6::shape_3" avatarSet="rakazo" />);
    expect(html).toContain("bot-character-eyes");
    expect(html).not.toContain("bot-avatar-body.png");
  });

  it("does not load arbitrary avatar URLs", () => {
    const html = renderToString(<LogoAvatar avatarValue="https://example.test/track.png" />);
    expect(html).not.toContain("example.test");
    expect(html).toContain('data-vector-body="true"');
    expect(html).not.toContain("<image");
  });

  it("retains a supplied body colour and uses light eyes on a dark body", () => {
    const html = renderToString(<LogoAvatar identity="dark-bot" avatarValue="#101014" />);
    expect(html).toContain('data-color="#101014"');
    const eyeInk = html.match(
      /<linearGradient[^>]*id="logo-eye[^>]*>[\s\S]*?stop-color="([^"]+)"/,
    )?.[1];
    expect(eyeInk).toBeDefined();
    expect(contrastRatio("#101014", eyeInk!)).toBeGreaterThanOrEqual(3);
    expect(html).toContain("radialGradient");
    expect(html).not.toContain("feColorMatrix");
  });

  it.each(BOT_COLOR_LIST)("keeps $name eyes legible", ({ hex }) => {
    const html = renderToString(<LogoAvatar identity="contrast-sample" avatarValue={hex} />);
    const eyeInk = html.match(
      /<linearGradient[^>]*id="logo-eye[^>]*>[\s\S]*?stop-color="([^"]+)"/,
    )?.[1];
    expect(eyeInk).toBeDefined();
    expect(contrastRatio(hex, eyeInk!)).toBeGreaterThanOrEqual(3);
  });
});
