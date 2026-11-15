import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LinkifiedText } from "./markdown.web";

describe("web user message links", () => {
  it("renders explicit urls as links and leaves markdown markers literal", () => {
    const html = renderToStaticMarkup(
      <LinkifiedText>{"# Title\n**important** https://example.com/docs."}</LinkifiedText>,
    );

    expect(html).toContain("# Title");
    expect(html).toContain("**important**");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noreferrer noopener"');
    // A bare address shows as host and path, after its site icon.
    expect(html).toContain('<bdi class="rk-chat-link-label">example.com/docs</bdi></a>.');
    // In the bubble's text colour, the underline is what marks the link.
    expect(html).toContain('class="rk-chat-link rk-chat-link-in-bubble"');
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<strong");
  });

  it("keeps an address link in the bubble's text colour", () => {
    const html = renderToStaticMarkup(<LinkifiedText>{"write to bob@example.com"}</LinkifiedText>);

    expect(html).toContain('href="mailto:bob@example.com"');
    expect(html).toContain('class="underline"');
    expect(html).not.toContain("text-link");
  });

  it("draws a sent page link as the page chip, or its plain title without an opener", () => {
    const text = "[Plan](page:pg_1)\nnice";
    const chip = renderToStaticMarkup(<LinkifiedText onOpenPage={() => {}}>{text}</LinkifiedText>);
    expect(chip).toContain('class="rk-chat-page-chip"');
    expect(chip).toContain('<span class="rk-chat-page-chip-title">Plan</span>');
    expect(chip).not.toContain("page:pg_1");

    const plain = renderToStaticMarkup(<LinkifiedText>{text}</LinkifiedText>);
    expect(plain).not.toContain("rk-chat-page-chip");
    expect(plain).toContain("Plan");
    expect(plain).not.toContain("page:pg_1");
  });
});
