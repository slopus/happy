import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageHoverMetadata } from "./MessageHoverMetadata";

describe("MessageHoverMetadata", () => {
  it("places bot actions flush to the right of the bubble", () => {
    const html = renderToStaticMarkup(
      <MessageHoverMetadata side="end">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    expect(html).toContain('data-testid="message-hover-rail"');
    expect(html).toContain("start-full");
    expect(html).toContain("ms-1");
    expect(html).toContain("top-1/2");
    expect(html).toContain("-translate-y-1/2");
    expect(html).not.toContain("ms-1.5");
    expect(html).not.toContain("bottom-0");
    expect(html).toContain("opacity-0");
    expect(html).toContain("@media(hover:hover)_and_(pointer:fine)");
    expect(html).toContain("group-hover/message:opacity-100");
    expect(html).toContain("focus-within:opacity-100");
  });

  it("mirrors user actions flush to the left of the bubble", () => {
    const html = renderToStaticMarkup(
      <MessageHoverMetadata side="start">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    expect(html).toContain("end-full");
    expect(html).toContain("me-1");
    expect(html).not.toContain("start-full");
  });

  it("drops the rail in-flow below the bubble on touch", () => {
    const bot = renderToStaticMarkup(
      <MessageHoverMetadata side="end">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );
    const user = renderToStaticMarkup(
      <MessageHoverMetadata side="start">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    for (const html of [bot, user]) {
      expect(html).toContain("[@media(hover:none)]:static");
      expect(html).toContain("[@media(hover:none)]:w-full");
      expect(html).toContain("[@media(hover:none)]:translate-y-0");
    }
    expect(bot).toContain("[@media(hover:none)]:justify-start");
    expect(user).toContain("[@media(hover:none)]:justify-end");
  });

  it("pins the rail open while a nested menu is active", () => {
    const html = renderToStaticMarkup(
      <MessageHoverMetadata pinned side="end">
        <div data-testid="message-actions" />
      </MessageHoverMetadata>,
    );

    expect(html).toContain("pointer-events-auto opacity-100");
    expect(html).not.toContain("group-hover/message:opacity-100");
  });
});
