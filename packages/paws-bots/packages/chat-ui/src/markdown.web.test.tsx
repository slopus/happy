// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { closeUnterminatedFence } from "./markdown";
import type { LinkFavicons } from "./markdown.web";
import {
  ChatMarkdown,
  defaultMarkdownCopy,
  LinkFaviconsContext,
  LinkifiedText,
  MarkdownCopyProvider,
  MarkdownLinkPromptProvider,
  RemoteImagesContext,
  useLinkPrompt,
} from "./markdown.web";

describe("web markdown remote images", () => {
  it("loads a remote image in place only after the reader asks", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const markdown = "![chart](https://images.example.test/tap.png)";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("img")).toBeNull();

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("chartimages.example.test");
    await act(async () => {
      button?.click();
    });
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://images.example.test/tap.png");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelector("button")).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();

    // The reader's choice holds for the session, so a remounted bubble keeps the image.
    expect(renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>)).toContain(
      'src="https://images.example.test/tap.png"',
    );
  });

  it("shows a placeholder when a tapped image is replaced with another url", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (src: string) => {
      root.render(<ChatMarkdown>{`![chart](${src})`}</ChatMarkdown>);
    };
    await act(async () => {
      render("https://images.example.test/first.png");
    });
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://images.example.test/first.png",
    );

    await act(async () => {
      render("https://images.example.test/second.png");
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("button")?.textContent).toContain("images.example.test");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("loads a linked image from a placeholder that is not inside the anchor", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const markdown =
      "See [![build](https://badge.example.test/tap-linked.svg)](https://ci.example.test/tap-linked) now";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("tap-linked.svg");
    expect(container.querySelector("a button")).toBeNull();

    const button = container.querySelector("button");
    const link = container.querySelector("a");
    expect(button?.closest("a")).toBeNull();
    expect(button?.textContent).toContain("build");
    expect(button?.textContent).toContain("badge.example.test");
    expect(link?.getAttribute("href")).toBe("https://ci.example.test/tap-linked");
    expect(link?.textContent).toBe("ci.example.test");
    expect(container.querySelectorAll("a")).toHaveLength(1);

    await act(async () => {
      button?.click();
    });
    const image = container.querySelector("a img");
    expect(image?.getAttribute("src")).toBe("https://badge.example.test/tap-linked.svg");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelector("a button")).toBeNull();
    expect(container.querySelector("button")).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps an image inside a rejected link as text when automatic loading is on", () => {
    const html = renderToStaticMarkup(
      <RemoteImagesContext.Provider value={true}>
        <ChatMarkdown>
          {
            "[![Open](https://example.test/visit)](javascript:alert(1)) [![File](https://example.test/file)](data:text/html,hi)"
          }
        </ChatMarkdown>
      </RemoteImagesContext.Provider>,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("example.test");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span>Open</span>");
    expect(html).toContain("<span>File</span>");
  });
});

const ICON = "data:image/png;base64,iVBORw0KGgo=";

async function renderLinks(
  markdown: string,
  favicons: LinkFavicons,
  options: { streaming?: boolean } = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (streaming = options.streaming, source = favicons) => {
    await act(async () => {
      root.render(
        <LinkFaviconsContext.Provider value={source}>
          <ChatMarkdown streaming={streaming}>{markdown}</ChatMarkdown>
        </LinkFaviconsContext.Provider>,
      );
    });
  };
  await render();
  return {
    container,
    render,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("web markdown website links", () => {
  it("isolates cached misses and pending answers when the API endpoint changes", async () => {
    let resolveOld!: (answer: { icon: string | null }) => void;
    const oldLoad = vi.fn<LinkFavicons["load"]>((origin) =>
      origin.includes("pending")
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({ icon: null }),
    );
    const newLoad = vi.fn<LinkFavicons["load"]>(async () => ({ icon: ICON }));
    const view = await renderLinks(
      "[Miss](https://scope-miss.example.test/) [Pending](https://scope-pending.example.test/)",
      { endpoint: "https://old-api.example.test", load: oldLoad },
    );
    expect(view.container.querySelectorAll("a img")).toHaveLength(0);
    await view.render(false, { endpoint: "https://new-api.example.test", load: newLoad });
    expect(newLoad).toHaveBeenCalledTimes(2);
    expect(view.container.querySelectorAll("a img")).toHaveLength(2);
    await act(async () => {
      resolveOld({ icon: null });
    });
    expect(view.container.querySelectorAll("a img")).toHaveLength(2);
    await view.cleanup();
  });

  it("draws the API's site icon in a hidden tile before the author's label", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await renderLinks(
      "Traffic plunges. [Post](https://icon-a.example.test/p/1) and [odds](https://icon-a.example.test/o)",
      { load },
    );
    const links = view.container.querySelectorAll("a");
    expect(links).toHaveLength(2);
    const [post] = links;
    expect(post?.getAttribute("href")).toBe("https://icon-a.example.test/p/1");
    expect(post?.getAttribute("class")).toBe("rk-chat-link");
    const tile = post?.querySelector(".rk-chat-link-tile");
    expect(tile?.getAttribute("aria-hidden")).toBe("true");
    expect(tile?.classList.contains("rk-chat-link-tile-icon")).toBe(true);
    expect(tile?.querySelector("img")?.getAttribute("src")).toBe(ICON);
    expect(tile?.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(post?.querySelector(".rk-chat-link-label")?.textContent).toBe("Post");
    // The link reads as its label alone: the tile has no text and is hidden.
    expect(post?.textContent).toBe("Post");
    // One lookup per origin, by origin only: the path never leaves the client.
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("https://icon-a.example.test");
    await view.cleanup();
  });

  it("shortens a bare URL to host and path", async () => {
    const view = await renderLinks(
      "See https://www.icon-b.example.test/status/123?s=20 and <https://icon-b.example.test/>",
      { load: async () => ({ icon: null }) },
    );
    const labels = [...view.container.querySelectorAll(".rk-chat-link-label")].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["icon-b.example.test/status/123", "icon-b.example.test"]);
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(
      "https://www.icon-b.example.test/status/123?s=20",
    );
    await view.cleanup();
  });

  it("keeps the destination when a bare URL is shortened at an emoji", async () => {
    const prefix = "a".repeat(26);
    const href = `https://example.com/${prefix}%F0%9F%98%80tail`;
    const view = await renderLinks(`<${href}>`, { load: async () => ({ icon: null }) });
    expect(view.container.querySelector(".rk-chat-link-label")?.textContent).toBe(
      `example.com/${prefix}…`,
    );
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(href);
    await view.cleanup();
  });

  it("shows the globe until an icon arrives, and when there is none", async () => {
    let resolve: (answer: { icon: string | null }) => void = () => undefined;
    const view = await renderLinks("[Docs](https://icon-c.example.test/docs)", {
      load: () => new Promise((done) => (resolve = done)),
    });
    const tile = () => view.container.querySelector(".rk-chat-link-tile");
    expect(tile()?.querySelector("svg")).not.toBeNull();
    expect(tile()?.classList.contains("rk-chat-link-tile-icon")).toBe(false);
    await act(async () => {
      resolve({ icon: null });
    });
    expect(tile()?.querySelector("img")).toBeNull();
    expect(tile()?.querySelector("svg")).not.toBeNull();
    await view.cleanup();
  });

  it("falls back to the globe when the icon fails or is a 1×1 pixel", async () => {
    const view = await renderLinks(
      "[A](https://icon-d.example.test/) [B](https://icon-e.example.test/)",
      { load: async () => ({ icon: ICON }) },
    );
    const [first, second] = view.container.querySelectorAll<HTMLImageElement>("a img");
    await act(async () => {
      first?.dispatchEvent(new Event("error"));
      Object.defineProperty(second, "naturalWidth", { value: 1 });
      Object.defineProperty(second, "naturalHeight", { value: 1 });
      second?.dispatchEvent(new Event("load"));
    });
    expect(view.container.querySelectorAll("a img")).toHaveLength(0);
    expect(view.container.querySelectorAll("a .rk-chat-link-tile svg")).toHaveLength(2);
    await view.cleanup();
  });

  it("shows the globe after a failed lookup and asks again only after a while", async () => {
    const load = vi.fn<LinkFavicons["load"]>(async () => {
      throw new Error("Not found");
    });
    const markdown = "[A](https://icon-j.example.test/) [B](https://icon-j.example.test/b)";
    const first = await renderLinks(markdown, { load });
    expect(first.container.querySelectorAll(".rk-chat-link-tile svg")).toHaveLength(2);
    await first.cleanup();
    const second = await renderLinks(markdown, { load });
    expect(second.container.querySelectorAll(".rk-chat-link-tile svg")).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(1);
    await second.cleanup();

    // After an outage, a later mount tries once more.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
    load.mockResolvedValue({ icon: ICON });
    const third = await renderLinks(markdown, { load });
    expect(load).toHaveBeenCalledTimes(2);
    expect(third.container.querySelectorAll(".rk-chat-link-tile img")).toHaveLength(2);
    await third.cleanup();
    clock.mockRestore();
  });

  it("asks a busy server again a little later instead of remembering a miss", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const load = vi
        .fn<LinkFavicons["load"]>()
        .mockResolvedValueOnce({ icon: null, retry: true })
        .mockResolvedValue({ icon: ICON });
      const view = await renderLinks("[Busy](https://icon-l.example.test/)", { load });
      expect(view.container.querySelector(".rk-chat-link-tile svg")).not.toBeNull();
      expect(load).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(view.container.querySelector(".rk-chat-link-tile img")?.getAttribute("src")).toBe(
        ICON,
      );
      await view.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking a busy server once no link to that site is on screen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const load = vi.fn<LinkFavicons["load"]>(async () => ({ icon: null, retry: true }));
      const view = await renderLinks(
        "[A](https://icon-n.example.test/) [B](https://icon-n.example.test/b)",
        { load },
      );
      expect(load).toHaveBeenCalledTimes(1);
      await view.cleanup();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(load).toHaveBeenCalledTimes(1);

      // Nothing was remembered, so the next link to that site asks again.
      load.mockResolvedValue({ icon: ICON });
      const again = await renderLinks("[A](https://icon-n.example.test/)", { load });
      expect(load).toHaveBeenCalledTimes(2);
      expect(again.container.querySelector(".rk-chat-link-tile img")).not.toBeNull();
      await again.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a server that stays busy, then waits like any failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const load = vi.fn<LinkFavicons["load"]>(async () => ({ icon: null, retry: true }));
      const view = await renderLinks("[Busy](https://icon-m.example.test/)", { load });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(load).toHaveBeenCalledTimes(3);
      await view.cleanup();
      const again = await renderLinks("[Busy](https://icon-m.example.test/)", { load });
      expect(load).toHaveBeenCalledTimes(3);
      expect(again.container.querySelector(".rk-chat-link-tile svg")).not.toBeNull();
      await again.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for no icon while a reply streams, then loads it", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await renderLinks(
      "Partial https://icon-f.example.test/x",
      { load },
      {
        streaming: true,
      },
    );
    expect(view.container.querySelector(".rk-chat-link-tile svg")).not.toBeNull();
    expect(load).not.toHaveBeenCalled();
    await view.render(false);
    expect(load).toHaveBeenCalledWith("https://icon-f.example.test");
    expect(view.container.querySelector(".rk-chat-link-tile img")).not.toBeNull();
    await view.cleanup();
  });

  it("gives no tile to links that are not websites", async () => {
    const load = vi.fn(async () => ({ icon: ICON }));
    const view = await renderLinks(
      [
        "[mail](mailto:someone@example.com)",
        "[call](tel:+15555550100)",
        "[docs](/docs)",
        "[top](#top)",
        "[bad](javascript:alert(1))",
        "`https://icon-g.example.test/in-code`",
        "[![badge](data:image/png;base64,iVBORw0KGgo=)](https://icon-g.example.test/badge)",
        "[![build](https://badge.example.test/b.svg)](https://icon-g.example.test/ci)",
      ].join("\n\n"),
      { load },
    );
    expect(view.container.querySelector(".rk-chat-link-tile")).toBeNull();
    expect(load).not.toHaveBeenCalled();
    await view.cleanup();
  });

  it("isolates a label so its direction characters stay inside the link", async () => {
    const view = await renderLinks(
      "See [\u202Eevil](https://icon-k.example.test/) then [next](https://icon-k.example.test/n)",
      { load: async () => ({ icon: null }) },
    );
    const labels = view.container.querySelectorAll("a > .rk-chat-link-label");
    expect([...labels].map((label) => label.tagName)).toEqual(["BDI", "BDI"]);
    expect(labels[0]?.textContent).toBe("\u202Eevil");
    await view.cleanup();
  });

  it("keeps formatting inside a labelled link", async () => {
    const view = await renderLinks("[**Bold** label](https://icon-h.example.test/)", {
      load: async () => ({ icon: null }),
    });
    expect(view.container.querySelector("a .rk-chat-link-label strong")?.textContent).toBe("Bold");
    await view.cleanup();
  });

  it("draws the tile in user messages too", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <LinkFaviconsContext.Provider value={{ load: async () => ({ icon: ICON }) }}>
          <LinkifiedText>
            {"look https://icon-i.example.test/a/b/ or mail me@example.com"}
          </LinkifiedText>
        </LinkFaviconsContext.Provider>,
      );
    });
    const links = container.querySelectorAll("a");
    expect(links[0]?.querySelector(".rk-chat-link-tile img")?.getAttribute("src")).toBe(ICON);
    expect(links[0]?.textContent).toBe("icon-i.example.test/a/b");
    expect(links[1]?.getAttribute("href")).toBe("mailto:me@example.com");
    expect(links[1]?.querySelector(".rk-chat-link-tile")).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

function buttonNamed(container: ParentNode, name: string) {
  return [...container.querySelectorAll<HTMLElement>("button")].find(
    (element) => element.textContent === name,
  );
}

async function render(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("web external link confirmation", () => {
  it("asks before following a link drawn inside an SVG", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    function Drawing() {
      const ref = useRef<HTMLDivElement>(null);
      const dialog = useLinkPrompt(ref);
      return (
        <div ref={ref}>
          <svg>
            <a href="https://example.test/point">
              <circle r={4} />
            </a>
          </svg>
          {dialog}
        </div>
      );
    }
    const view = await render(<Drawing />);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      view.container.querySelector("circle")?.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(document.querySelector("[role='alertdialog']")?.textContent).toContain(
      "https://example.test/point",
    );
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      buttonNamed(document, "Open")?.click();
    });
    expect(open).toHaveBeenCalledWith(
      "https://example.test/point",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
    await view.cleanup();
  });

  it("asks before an external bot link and opens it only after confirmation", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = await render(
      <ChatMarkdown>{"See [Docs](https://example.test/docs?x=1)"}</ChatMarkdown>,
    );
    const link = view.container.querySelector("a");
    expect(link?.textContent).toBe("Docs");

    await act(async () => {
      link?.click();
    });
    const dialog = document.querySelector("[role='alertdialog']");
    expect(dialog?.textContent).toContain("Open external link?");
    expect(dialog?.textContent).toContain("https://example.test/docs?x=1");
    expect(dialog?.querySelector("strong")?.textContent).toBe("example.test");
    expect(open).not.toHaveBeenCalled();

    await act(async () => {
      buttonNamed(document, "Cancel")?.click();
    });
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alertdialog']")).toBeNull();

    await act(async () => {
      view.container.querySelector("a")?.click();
    });
    await act(async () => {
      buttonNamed(document, "Open")?.click();
    });
    expect(open).toHaveBeenCalledWith(
      "https://example.test/docs?x=1",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
    await view.cleanup();
  });

  it("asks before a linked remote image destination", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = await render(
      <ChatMarkdown>
        {
          "[![Quarterly chart](https://images.example.test/chart.png)](https://images.example.test/chart.png)"
        }
      </ChatMarkdown>,
    );
    await act(async () => {
      view.container.querySelector("a")?.click();
    });
    const dialog = document.querySelector("[role='alertdialog']");
    expect(dialog?.querySelector("strong")?.textContent).toBe("images.example.test");
    expect(dialog?.textContent).toContain("https://images.example.test/chart.png");
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    await view.cleanup();
  });

  it("opens in-app routes, mailto, and tel without asking", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = await render(
      <ChatMarkdown>
        {"[home](/threads/1) [mail](mailto:user@example.test) [call](tel:+15551212)"}
      </ChatMarkdown>,
    );
    const links = [...view.container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/threads/1",
      "mailto:user@example.test",
      "tel:+15551212",
    ]);
    for (const link of links) {
      link.addEventListener("click", (event) => event.preventDefault());
      await act(async () => {
        link.click();
      });
    }
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    await view.cleanup();
  });

  it("opens the link and trusts its site from the third button", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const trustSite = vi.fn(async () => {
      throw new Error("offline");
    });
    const view = await render(
      <MarkdownLinkPromptProvider trustedSites={[]} trustSite={trustSite}>
        <ChatMarkdown>{"See [Docs](https://docs.example.test/a)"}</ChatMarkdown>
      </MarkdownLinkPromptProvider>,
    );
    await act(async () => {
      view.container.querySelector("a")?.click();
    });
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      buttonNamed(document, "Always open example.test")?.click();
    });
    // A failed save still opens the link.
    expect(open).toHaveBeenCalledWith(
      "https://docs.example.test/a",
      "_blank",
      "noopener,noreferrer",
    );
    expect(trustSite).toHaveBeenCalledWith("https://docs.example.test/a");
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
    open.mockRestore();
    await view.cleanup();
  });

  it("offers no third button without a way to trust a site", async () => {
    const view = await render(<ChatMarkdown>{"[Docs](https://example.test/a)"}</ChatMarkdown>);
    await act(async () => {
      view.container.querySelector("a")?.click();
    });
    const dialog = document.querySelector("[role='alertdialog']");
    expect([...(dialog?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "Cancel",
      "Open",
    ]);
    await act(async () => {
      buttonNamed(document, "Cancel")?.click();
    });
    await view.cleanup();
  });

  it("opens a link to a trusted site directly", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = await render(
      <MarkdownLinkPromptProvider trustedSites={["example.test"]} trustSite={vi.fn()}>
        <ChatMarkdown>
          {"[Docs](https://docs.example.test/a) [Other](https://other.test/a)"}
        </ChatMarkdown>
      </MarkdownLinkPromptProvider>,
    );
    const [trusted, other] = [...view.container.querySelectorAll("a")];
    let prevented: boolean | undefined;
    const record = (event: MouseEvent) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", record);
    await act(async () => {
      trusted?.click();
    });
    expect(prevented).toBe(false);
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
    await act(async () => {
      other?.click();
    });
    expect(prevented).toBe(true);
    expect(document.querySelector("[role='alertdialog'] strong")?.textContent).toBe("other.test");
    document.removeEventListener("click", record);
    open.mockRestore();
    await view.cleanup();
  });

  it("asks before a link in plain user text", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const view = await render(<LinkifiedText>{"https://example.test/docs"}</LinkifiedText>);
    await act(async () => {
      view.container.querySelector("a")?.click();
    });
    expect(document.querySelector("[role='alertdialog'] strong")?.textContent).toBe("example.test");
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    await view.cleanup();
  });
});

describe("web markdown code copy", () => {
  it("copies a fence's code exactly as written, then reads Copied", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{"```ts\nconst a = 1;\n\n  return a;\n```"}</ChatMarkdown>);
    });
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Copy code");
    await act(async () => {
      button?.click();
    });
    expect(writeText).toHaveBeenCalledWith("const a = 1;\n\n  return a;");
    expect(button?.getAttribute("aria-label")).toBe("Copied");
    await act(async () => {
      root.unmount();
    });
    container.remove();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("gives an empty fence no copy button, as on mobile", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"```ts\n```\n\n```\n\n\n```\n\n    indented"}</ChatMarkdown>,
    );
    expect(html.match(/<pre/g)).toHaveLength(3);
    expect(html.match(/aria-label="Copy code"/g)).toHaveLength(1);
  });

  it("renders provider copy in place of the English defaults", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `| ${i + 1} | v${i + 1} |`).join("\n");
    const markdown = ["```ts", "const a = 1;", "```", "", "| N | V |", "|---|---|", rows].join(
      "\n",
    );
    const html = renderToStaticMarkup(
      <MarkdownCopyProvider
        copy={{
          ...defaultMarkdownCopy,
          copyCode: "Copiar código",
          copyRows: "Copiar filas",
          rowRange: (from, to, total) => `${from} a ${to} de ${total} filas`,
        }}
      >
        <ChatMarkdown>{markdown}</ChatMarkdown>
      </MarkdownCopyProvider>,
    );
    expect(html).toContain('aria-label="Copiar código"');
    expect(html).toContain('aria-label="Copiar filas"');
    expect(html).toContain("1 a 10 de 12 filas");
  });
});

describe("web markdown prose fences", () => {
  const draft =
    "Dear team, this line of prose is far wider than a bubble, so it wraps instead of scrolling.";

  function renderMarkdown(markdown: string) {
    const holder = document.createElement("div");
    holder.innerHTML = renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>);
    return holder;
  }

  it.each(["text", "txt", "plaintext", "Text"])("wraps a fence marked %j as prose", (language) => {
    const html = renderMarkdown(`\`\`\`${language}\n${draft}\n\`\`\``);
    expect(html.querySelector("pre")?.className).toBe("rk-chat-markdown-pre-prose");
  });

  it.each(["ts", ""])("keeps a fence marked %j as code", (language) => {
    const html = renderMarkdown(`\`\`\`${language}\nconst a = 1;\n\`\`\``);
    expect(html.querySelector("pre")?.className).toBe("");
  });

  it("copies a text fence's code exactly as written", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{"```text\nDear team,\n\n  see you Monday.\n```"}</ChatMarkdown>);
    });
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Copy code");
    await act(async () => {
      button?.click();
    });
    expect(writeText).toHaveBeenCalledWith("Dear team,\n\n  see you Monday.");
    await act(async () => {
      root.unmount();
    });
    container.remove();
    Reflect.deleteProperty(navigator, "clipboard");
  });
});

describe("web markdown mentions", () => {
  it("draws a mention the app renders and keeps an unknown one as its name", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        renderMention={(id, name) => (id === "bot-1" ? <b data-id={id}>{name}</b> : undefined)}
      >
        {"[Planner](rakazo-mention:bot-1) and [Other](rakazo-mention:bot-2)"}
      </ChatMarkdown>,
    );
    expect(html).toContain('<b data-id="bot-1">Planner</b>');
    expect(html).toContain("<span>Other</span>");
    expect(html).not.toContain("<a");
  });
});

describe("web markdown streaming", () => {
  it("draws every streamed prefix as the whole text would be drawn", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const reply = [
      "1. one",
      "",
      "3. three",
      "",
      "| Step | Rows |",
      "| --- | ---: |",
      "| Import | 12 |",
      "",
      "```sql",
      "SELECT 1;",
      "",
      "SELECT 2;",
      "```",
      "",
      "- a",
      "",
      "  continued",
      "Done",
      "===",
      "",
      "[foo",
      "bar]: https://example.com/",
      "",
      "See [foo bar].",
      "",
      "End.",
      "",
      "Really.",
    ].join("\n");
    const shape = (node: Node): string =>
      [...node.childNodes]
        .map((child) =>
          child instanceof Element ? `<${child.tagName}>${shape(child)}</>` : child.textContent,
        )
        .join("");
    const streamed = document.createElement("div");
    const whole = document.createElement("div");
    const streamedRoot = createRoot(streamed);
    const wholeRoot = createRoot(whole);
    for (let end = 1; end <= reply.length; end += 1) {
      const text = reply.slice(0, end);
      await act(async () => {
        streamedRoot.render(<ChatMarkdown streaming>{text}</ChatMarkdown>);
        wholeRoot.render(<ChatMarkdown key={end}>{closeUnterminatedFence(text)}</ChatMarkdown>);
      });
      expect(shape(streamed.firstChild!), JSON.stringify(text)).toBe(
        `${shape(whole.firstChild!)}<SPAN></>`,
      );
    }
    await act(async () => {
      streamedRoot.render(<ChatMarkdown>{reply}</ChatMarkdown>);
    });
    expect(shape(streamed)).toBe(shape(whole));
    await act(async () => {
      streamedRoot.unmount();
      wholeRoot.unmount();
    });
  });

  it("keeps a streamed table's sort when text before it changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const table = "| Item | Qty |\n| --- | --- |\n| a | 2 |\n| b | 1 |";
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown streaming>{table}</ChatMarkdown>);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Sort by Qty"]')!.click();
    });
    await act(async () => {
      root.render(<ChatMarkdown streaming>{`Results updated.\n\n${table}`}</ChatMarkdown>);
    });
    expect(container.querySelector("th[aria-sort]")?.getAttribute("aria-sort")).toBe("ascending");
    await act(async () => {
      root.unmount();
    });
  });
});

describe("web markdown streamed definitions", () => {
  it("resolves a reference whose definition label spans lines and escapes a bracket", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown streaming>
        {"[foo\nb\\]ar]: https://example.test/ref\n\nSee [foo b\\]ar]."}
      </ChatMarkdown>,
    );
    expect(html).toContain('href="https://example.test/ref"');
  });
});

describe("web markdown page links", () => {
  it("draws a page link as a chip that opens the page, or as its title without a handler", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const openPage = vi.fn();
    const markdown =
      "See [Duplex voice](page:page_1) and [x](javascript:alert(1)) and [y](rakazo://settings) and [z](page:a/b)";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown onOpenPage={openPage}>{markdown}</ChatMarkdown>);
    });
    const chips = container.querySelectorAll<HTMLButtonElement>("button.rk-chat-page-chip");
    expect([...chips].map((chip) => chip.textContent)).toEqual(["Duplex voice"]);
    expect(chips[0]!.querySelector("svg")).not.toBeNull();
    await act(async () => {
      chips[0]!.click();
    });
    expect(openPage).toHaveBeenCalledWith("page_1");
    // Other schemes and a malformed page link keep today's plain-text rendering.
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("See Duplex voice and x and y and z");
    await act(async () => {
      root.unmount();
    });
    container.remove();

    const html = renderToStaticMarkup(
      <ChatMarkdown>{"See [Duplex voice](page:page_1)"}</ChatMarkdown>,
    );
    expect(html).toContain("<span>Duplex voice</span>");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a");
  });
});

describe("web markdown parser failure", () => {
  it("shows a message the parser cannot handle as plain text", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const nested = `${">".repeat(20_000)} deep`;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{nested}</ChatMarkdown>);
    });
    expect(container.querySelector(".rk-chat-markdown p")?.textContent).toBe(nested);

    await act(async () => {
      root.render(<ChatMarkdown>{"**fine**"}</ChatMarkdown>);
    });
    expect(container.querySelector("strong")?.textContent).toBe("fine");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });
});
