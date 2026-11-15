import { ChatMarkdown, RemoteImagesContext } from "@rakazo/chat-ui/web";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("ChatMarkdown", () => {
  it("renders the formatting commonly emitted by assistants", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"## Capabilities\n\n- **Write files**\n- Run `commands`"}</ChatMarkdown>,
    );

    expect(html).toContain("<h2>Capabilities</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>Write files</strong>");
    expect(html).toContain("<code>commands</code>");
  });

  it("does not inject raw HTML or unsafe link protocols", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{'<script>alert("xss")</script> [bad](javascript:alert(1))'}</ChatMarkdown>,
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });

  it("renders unsafe links as plain text instead of a link back into the app", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"[x](javascript:alert(1)) [d](data:text/html,hi) [ok](https://example.test)"}
      </ChatMarkdown>,
    );

    expect(html).not.toContain('href=""');
    expect(html).toContain("<span>x</span>");
    expect(html).toContain("<span>d</span>");
    expect(html).toMatch(/<a[^>]*href="https:\/\/example.test"[^>]*target="_blank"/);
  });

  it("shows remote images as load buttons and relative ones as text, without loading them", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {
          '![chart](https://images.example.test/p.gif?d=secret "Q3 revenue") ![logo](/api/v1/p.gif) ![](./p.gif)'
        }
      </ChatMarkdown>,
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("images.example.test/p.gif");
    expect(html).toContain(
      '<button type="button" class="rk-chat-markdown-image" title="Q3 revenue">',
    );
    expect(html).toContain(
      '<span>chart</span><span class="rk-chat-markdown-image-host">images.example.test</span></button>',
    );
    expect(html).not.toContain('href="/api/v1/p.gif"');
    expect(html).not.toContain('href="./p.gif"');
    expect(html).toContain("logo");
    expect(html).toContain("./p.gif");
  });

  it("loads remote images at once, without a referrer, when the reader turned that on", () => {
    const html = renderToStaticMarkup(
      <RemoteImagesContext.Provider value={true}>
        <ChatMarkdown>
          {
            "![chart](https://images.example.test/auto.png) [![build](https://badge.example.test/auto.svg)](https://ci.example.test/run)"
          }
        </ChatMarkdown>
      </RemoteImagesContext.Provider>,
    );

    expect(html).toContain(
      '<img src="https://images.example.test/auto.png" alt="chart" loading="lazy" referrerPolicy="no-referrer"/>',
    );
    expect(html).toContain(
      '<a href="https://ci.example.test/run" target="_blank" rel="noreferrer noopener"><img src="https://badge.example.test/auto.svg"',
    );
    expect(html).not.toContain("<button");
  });

  it("never puts an unsafe image source into an attribute", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"![x](javascript:alert(1)) ![](data:text/html,hi) ![p](//attacker.example.test/p.gif)"}
      </ChatMarkdown>,
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a");
    expect(html).not.toMatch(/(src|href)="(javascript:|data:|\/\/)/);
    expect(html).toContain("x");
    expect(html).toContain("p");
  });

  it("shows an image inside an open link as a placeholder that does not request it", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"[![build](https://badge.example.test/b.svg)](https://ci.example.test/run)"}
      </ChatMarkdown>,
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("badge.example.test/b.svg");
    const anchor = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(anchor).not.toContain("<button");
    expect(anchor).toContain("ci.example.test");
    expect(html).toContain('class="rk-chat-markdown-image"');
    expect(html).toContain(">build</span>");
    expect(html).toContain("badge.example.test");
  });

  it("keeps an image inside a rejected link as plain text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {
          "[![Open](https://example.test/visit)](javascript:alert(1)) [![File](https://example.test/file)](data:text/html,hi)"
        }
      </ChatMarkdown>,
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("example.test");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span>Open</span>");
    expect(html).toContain("<span>File</span>");
  });

  it("shows mailto and tel image sources as text and keeps mailto links", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {
          "[mail](mailto:user@example.test) ![Contact](mailto:user@example.test) ![Call](tel:+15551212)"
        }
      </ChatMarkdown>,
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("tel:");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(
      '<a href="mailto:user@example.test" target="_blank" rel="noreferrer noopener">mail</a>',
    );
    expect(html).toContain("Contact");
    expect(html).toContain("Call");
  });

  it("renders embedded image data inline", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"![dot](data:image/png;base64,iVBORw0KGgo=)"}</ChatMarkdown>,
    );

    expect(html).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot"');
  });

  it("renders incomplete streaming code fences as code", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown streaming>{"```ts\nconst live = true;"}</ChatMarkdown>,
    );

    expect(html).toContain("<pre>");
    expect(html).toContain("const live = true;");
    expect(html).toContain("rk-chat-markdown-cursor");
  });

  it("renders a copy button alongside each code block", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"```ts\nconst value = 1;\n```"}</ChatMarkdown>,
    );

    expect(html).toContain("rk-chat-markdown-pre-wrap");
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain("rk-chat-markdown-copy");
  });

  it("renders GFM tables as an interactive table card", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"| Product | Price |\n| --- | ---: |\n| Alpha | 3 |\n| Beta | 10 |"}
      </ChatMarkdown>,
    );

    expect(html).toContain('data-testid="table-card"');
    expect(html).toContain('aria-label="Sort by Product"');
    expect(html).not.toContain("aria-sort");
    expect(html).toContain('aria-label="Copy rows"');
    expect(html).toContain('aria-label="Download CSV"');
    expect(html).toContain('aria-label="Expand table"');
    expect(html).toContain("Alpha");
    expect(html).toContain("2 rows");
  });

  it("right-aligns numeric table columns", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"| Item | Qty |\n| --- | --- |\n| widget | 12 |"}</ChatMarkdown>,
    );

    expect(html).toContain("rk-align-right");
  });

  it("respects explicit left alignment for numeric columns", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{"| Qty |\n| :--- |\n| 12 |"}</ChatMarkdown>);

    expect(html).not.toContain("rk-align-right");
  });

  it("preserves sanitized inline markdown in table headers and cells", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {
          "| [Name](https://example.com/name) | **Qty** |\n| --- | --- |\n| [Docs](https://example.com) and **important** | 1 |"
        }
      </ChatMarkdown>,
    );

    expect(html).toContain('aria-label="Sort by Name"');
    expect(html).toContain('aria-label="Sort by Qty"');
    const head = html.slice(0, html.indexOf("<tbody"));
    expect(head).toContain('class="rk-table-sort-label"');
    expect(head).toContain('href="https://example.com/name"');
    expect(head).toContain("<strong>Qty</strong>");
    const nameSort = head.slice(head.indexOf('aria-label="Sort by Name"'));
    const nameSortButton = nameSort.slice(0, nameSort.indexOf("</button>"));
    expect(nameSortButton).not.toContain("<a");
    expect(nameSortButton).not.toContain("href=");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<strong>important</strong>");
  });

  it("keeps table cell content sanitized", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"| A | B |\n| --- | --- |\n| <script>alert(1)</script> | [bad](javascript:alert(1)) |"}
      </ChatMarkdown>,
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('data-testid="table-card"');
  });

  it.each([
    '<img alt="Chart" data-alt="Decorative">',
    '<img title="1 > 0" alt="Chart">',
    '<img alt="Chart" title="alt=Decorative">',
  ])("renders the real table image description as text: %s", (image) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{`| Description |\n| --- |\n| ${image} |`}</ChatMarkdown>,
    );
    expect(html).toContain(">Chart</span>");
    expect(html).not.toContain("Decorative");
    expect(html).not.toContain("<img");
  });

  it("preserves spacing and image descriptions when table HTML is skipped", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {'| A | B |\n| --- | --- |\n| one<br>two | <img src="chart.png" alt="chart &amp; graph"> |'}
      </ChatMarkdown>,
    );

    expect(html).toContain("one two");
    expect(html).toContain("chart &amp; graph");
    expect(html).not.toContain("&amp;amp;");
  });
});
